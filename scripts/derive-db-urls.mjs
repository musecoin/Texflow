// Normalises DATABASE_URL (as pasted into a hosting dashboard) and derives APP_DATABASE_URL.
// Prints two lines: the clean owner URL and the app-role URL. Diagnostics go to stderr and
// never include passwords.
const raw = process.env.DATABASE_URL ?? '';
const appPw = process.env.APP_DB_PASSWORD ?? '';
const fail = (msg) => { console.error('DATABASE_URL problem: ' + msg); process.exit(1); };

// first postgres URL anywhere in the value (tolerates DATABASE_URL="...", quotes, extra lines)
const found = raw.match(/postgres(?:ql)?:\/\/[^\s"'`]+/);
if (!found) fail(`no postgresql:// URL found (value has ${raw.length} chars, ${raw.split(/\r?\n/).length} line(s), starts with "${raw.trim().slice(0, 12).replace(/[^A-Za-z_:\/=" ]/g, '*')}")`);
const url = found[0];
const m = /^(postgres(?:ql)?):\/\/([^:@\/?#]+)(?::([^@\/?#]*))?@([^\/?#]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(url);
if (!m) fail('URL is not in the form postgresql://user:password@host/database?params');
const [, scheme, user, , host, path = '/neondb', query = ''] = m;
console.error(`database: user=${decodeURIComponent(user)} host=${host} db=${path.slice(1)} params=${query.replace(/password=[^&]*/g, 'password=***') || '(none)'}`);
if (!appPw) fail('APP_DB_PASSWORD is empty');
const params = new URLSearchParams(query.replace(/^\?/, ''));
params.delete('channel_binding'); // not supported by the built-in client; TLS is still required via sslmode
const q = params.toString() ? '?' + params.toString() : '';
process.stdout.write(`${scheme}://${user}${m[3] !== undefined ? ':' + m[3] : ''}@${host}${path}${q}\n`);
process.stdout.write(`${scheme}://texflow_app:${encodeURIComponent(appPw)}@${host}${path}${q}\n`);
