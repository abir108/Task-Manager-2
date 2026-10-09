/* Loads KEY=VALUE lines from a .env file next to the app into process.env, so settings
   (Slack token, SMTP login, ...) live in one file that is not part of the code.
   Real environment variables always win. Must be required before anything reads them. */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, ".env");
if (fs.existsSync(file)) {
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) return;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  });
}
