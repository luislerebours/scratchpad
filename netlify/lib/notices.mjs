import { sendEmail } from './email.mjs';
import { deviceOf } from './device.mjs';

// ---- Security notices ----
// A short email when something changes about how the account is reached or
// kept, so the owner hears about it if it wasn't them. Says when, and the kind
// of device (from its browser), nothing else; never stored. A notice that can't
// be sent never stops the action itself.

const SUPPORT = 'support@sector809labs.com';

const whenText = () => `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date())} UTC`;

const NOTICES = {
  password: {
    subject: 'Your ScrapSheet password was changed',
    heading: 'Your password was changed',
    intro: 'The password for your ScrapSheet account was just changed, and every other device was signed out.'
  },
  'start-over': {
    subject: 'Your ScrapSheet account was started over',
    heading: 'Your account was started over',
    intro: 'Your ScrapSheet account was started over with a new password. Everything that was in it was erased, and every other device was signed out.'
  },
  recovery: {
    subject: 'A new ScrapSheet recovery key was made',
    heading: 'A new recovery key was made',
    intro: 'A new recovery key was just made for your ScrapSheet account. The old one no longer works.'
  },
  email: {
    subject: 'Your ScrapSheet email was changed',
    heading: 'Your email was changed',
    intro: 'Your ScrapSheet account now signs in with a different email address, and every device was signed out.'
  },
  'signout-all': {
    subject: 'Signed out of ScrapSheet everywhere',
    heading: 'Signed out of all devices',
    intro: 'Every device signed in to your ScrapSheet account was just signed out.'
  },
  deleted: {
    subject: 'Your ScrapSheet account was deleted',
    heading: 'Your account was deleted',
    intro: 'Your ScrapSheet account and everything in it were permanently deleted.'
  }
};

// Part of an address, so the old one can recognise the new one without seeing it whole.
const masked = email => {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`;
};

export async function securityNotice(req, email, kind, { cancelled = false, to = null } = {}) {
  const n = NOTICES[kind];
  const origin = new URL(req.url).origin;
  const intro = n.intro + (cancelled ? ' Your Pro subscription was cancelled too, so you won’t be charged again.' : '') + (to ? ` The new address starts ${masked(to)}.` : '');
  try {
    await sendEmail({
      to: email,
      origin,
      subject: n.subject,
      preheader: intro,
      heading: n.heading,
      intro,
      // Done by support: when, not the staff member's device.
      box: kind === 'deleted-by-support' ? { title: 'When', body: whenText() } : { title: 'When and where', body: `${whenText()} · ${deviceOf(req)}` },
      ...(kind.startsWith('deleted') ? {} : { button: { label: 'Open ScrapSheet', url: origin } }),
      note: kind.startsWith('deleted')
        ? `If you didn’t do this, email ${SUPPORT} right away. Thanks for using ScrapSheet.`
        : kind === 'email'
          ? `Wasn’t you? Email ${SUPPORT} from this address right away.`
          : `Wasn’t you? Reset your password right away (“Forgot password?” on the sign-in page) and email ${SUPPORT}.`,
      // Local tests read this line.
      devLog: `[dev mail] to ${email}: security ${kind} (${deviceOf(req)})${cancelled ? ' +cancelled' : ''}`
    });
  } catch (err) {
    console.error('Security notice not sent', kind, err?.message);
  }
}

// When support deletes an account (asked by email, from the admin dashboard).
NOTICES['deleted-by-support'] = {
  subject: 'Your ScrapSheet account was deleted',
  heading: 'Your account was deleted',
  intro: 'As you asked, we deleted your ScrapSheet account and everything in it.'
};
