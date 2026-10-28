#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const filename = 'gpt-6.1-sol-v1-rc2.md';
const archiveHash = '007b8c5858110b809e5b90cd2c18bdc6965246aaee5af170b5487818b7055364';
const stateName = '.gpt56-sol-instruct-state.json';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function promptFromArchive() {
  const archive = fs.readFileSync(path.join(__dirname, 'gpt-6.1-sol-v1-rc2.zip'));
  if (hash(archive) !== archiveHash || archive.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid prompt archive');
  const flags = archive.readUInt16LE(6);
  const method = archive.readUInt16LE(8);
  const size = archive.readUInt32LE(18);
  const nameLength = archive.readUInt16LE(26);
  const start = 30 + nameLength + archive.readUInt16LE(28);
  if ((flags & 8) || archive.subarray(30, 30 + nameLength).toString() !== filename) throw new Error('Unexpected prompt archive format');
  const data = archive.subarray(start, start + size);
  const result = method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : null;
  if (!result || result.length !== archive.readUInt32LE(22)) throw new Error('Invalid prompt data');
  return result;
}

function atomicWrite(file, data) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${file}`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, data, { mode, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function install() {
  if (process.argv.length !== 2) throw new Error('This installer takes no arguments; set CODEX_HOME to select a directory.');
  const prompt = promptFromArchive();
  const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const config = path.join(home, 'config.toml');
  const statePath = path.join(home, stateName);
  const destination = path.join(home, filename);
  fs.mkdirSync(home, { recursive: true });
  if (fs.existsSync(config) && fs.lstatSync(config).isSymbolicLink()) throw new Error(`Config is a symlink: ${config}`);
  const original = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) || [];
  const table = lines.findIndex(line => /^\s*\[/.test(line));
  const rootEnd = table < 0 ? lines.length : table;
  const indexes = lines.slice(0, rootEnd).map((line, i) => /^\s*model_instructions_file\s*=/.test(line) ? i : -1).filter(i => i >= 0);
  if (indexes.length > 1) throw new Error('Multiple top-level model_instructions_file entries');
  const oldLine = indexes.length ? lines[indexes[0]].replace(/\r?\n$/, '') : null;
  if (oldLine !== null && !/^\s*model_instructions_file\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/.test(oldLine)) throw new Error('Unsupported model_instructions_file entry');
  let state;
  if (fs.existsSync(statePath)) {
    if (fs.lstatSync(statePath).isSymbolicLink()) throw new Error('State file is a symlink');
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state || state.version !== 2 || !state.managed_prompts || typeof state.managed_prompts !== 'object' || Array.isArray(state.managed_prompts)) throw new Error('Invalid installer state');
    if (state.previous_model_instructions_line !== null && (typeof state.previous_model_instructions_line !== 'string' || !/^\s*model_instructions_file\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/.test(state.previous_model_instructions_line))) throw new Error('Invalid previous instruction in installer state');
    for (const [name, metadata] of Object.entries(state.managed_prompts)) {
      if (!name || /[\\/]/.test(name) || !name.toLowerCase().endsWith('.md') || !metadata || !/^[0-9a-f]{64}$/.test(metadata.sha256) || typeof metadata.existed_before !== 'boolean') throw new Error('Invalid managed prompt in installer state');
    }
  } else {
    if (oldLine && /model_instructions_file\s*=\s*["'](?:\.\/)?gpt-(?:5\.6-sol|6(?:\.1)?-(?:astra|sol))/.test(oldLine)) throw new Error('Existing managed installation has no state; use the Python installer to migrate it');
    state = { version: 2, previous_model_instructions_line: oldLine, managed_prompts: {} };
  }
  const tracked = Object.prototype.hasOwnProperty.call(state.managed_prompts, filename);
  if ((fs.existsSync(destination) || (() => { try { return fs.lstatSync(destination).isSymbolicLink(); } catch { return false; } })()) && !tracked) throw new Error(`File already exists and is not managed: ${destination}`);
  if (fs.existsSync(config)) {
    const backup = `${config}.bak_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    fs.copyFileSync(config, backup, fs.constants.COPYFILE_EXCL);
    console.log(`Backup: ${backup}`);
  }
  const previous = state.managed_prompts[filename];
  state.managed_prompts[filename] = { sha256: hash(prompt), existed_before: previous ? previous.existed_before : false };
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const replacement = `model_instructions_file = "./${filename}"`;
  if (indexes.length) {
    const i = indexes[0];
    lines[i] = replacement + (lines[i].endsWith('\n') ? (lines[i].endsWith('\r\n') ? '\r\n' : '\n') : '');
  } else {
    if (rootEnd > 0 && !lines[rootEnd - 1].endsWith('\n')) lines[rootEnd - 1] += newline;
    lines.splice(rootEnd, 0, replacement + newline);
  }
  atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n');
  atomicWrite(destination, prompt);
  atomicWrite(config, lines.join(''));
  console.log(`Installed ${filename} in ${home}`);
  console.log('Restart Codex to load the instructions.');
}

try { install(); } catch (error) { console.error(`Installation failed: ${error.message}`); process.exitCode = 1; }
