const fs = require("fs");
const path = require("path");

const NOTES_DIR = path.join(__dirname, "notes");

function readNote(filename) {
  const safeName = path.basename(filename);
  const target = path.join(NOTES_DIR, safeName);
  return fs.readFileSync(target, "utf8");
}

module.exports = { readNote };
