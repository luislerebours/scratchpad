# Sourced by nightly.sh and when restoring (docs/RECOVERY.md): sets up the
# rclone remotes the backup uses, through environment variables (no file).
#   drive:  Google Drive, from your rclone config (RCLONE_CONFIG file)
#   vault:  the locked part of the backup, "<DRIVE_DIR>/locked", encrypted by
#           rclone (crypt) with BACKUP_PASSPHRASE: file contents and names
#   r2:     the R2 bucket (only when R2_ACCESS_KEY_ID is set)
# Needs: BACKUP_PASSPHRASE. Optional: DRIVE_DIR (default "drive:ScrapSheet
# backups"), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.

: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE (from your password manager)}"
export DRIVE_DIR="${DRIVE_DIR:-drive:ScrapSheet backups}"

export RCLONE_CONFIG_VAULT_TYPE=crypt
export RCLONE_CONFIG_VAULT_REMOTE="$DRIVE_DIR/locked"
export RCLONE_CONFIG_VAULT_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_VAULT_DIRECTORY_NAME_ENCRYPTION=true
RCLONE_CONFIG_VAULT_PASSWORD="$(rclone obscure - <<< "$BACKUP_PASSPHRASE")"
export RCLONE_CONFIG_VAULT_PASSWORD

if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
  : "${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID with the R2 keys}"
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
  export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
fi
