// How Blobs store names and keys become file names in the backup, and back.
// Keys hold "/" and mixed case, and the copy must restore on Windows too
// (case-insensitive file names), so only a-z, 0-9, "." , "_" and "-" stay as
// they are; a capital letter becomes "^" and the letter ("A" -> "^a"); every
// other byte becomes "~" and two hex digits ("/" -> "~2f").

export function encodeName(s) {
  let out = '';
  for (const byte of Buffer.from(String(s), 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[a-z0-9._-]/.test(c)) out += c;
    else if (/[A-Z]/.test(c)) out += '^' + c.toLowerCase();
    else out += '~' + byte.toString(16).padStart(2, '0');
  }
  // "." and ".." can't be file names.
  return out === '.' || out === '..' ? out.replace(/\./g, '~2e') : out;
}

export function decodeName(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '^') bytes.push(s.charCodeAt(++i) - 32);
    else if (c === '~') { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}
