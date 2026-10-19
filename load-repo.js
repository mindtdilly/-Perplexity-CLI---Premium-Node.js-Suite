#!/usr/bin/env node
/**
 * load-repo.js — clone or update a Git repo using an SSH key you pick
 * from ~/.ssh (or a custom path). Works alongside the Perplexity CLI
 * (same inquirer/chalk/ora stack).
 *
 * Usage:
 *   node load-repo.js [git-ssh-url] [target-dir]
 *   node load-repo.js git@github.com:lacquer-lab/-Perplexity-CLI---Premium-Node.js-Suite.git
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import Conf from 'conf';

const config = new Conf({ projectName: 'perplexity-cli' });

const DEFAULT_REPO =
  'git@github.com:lacquer-lab/-Perplexity-CLI---Premium-Node.js-Suite.git';

const SSH_DIR = path.join(os.homedir(), '.ssh');

// Files in ~/.ssh that are definitely not private keys.
const IGNORE = new Set([
  'config', 'known_hosts', 'known_hosts.old', 'authorized_keys',
  'environment', 'rc', 'agent',
]);

/** Return true if the file looks like a private key (any format). */
const looksLikePrivateKey = (file) => {
  try {
    const head = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 200);
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(head);
  } catch {
    return false;
  }
};

/** Try to read the comment/type from the matching .pub file. */
const describeKey = (privPath) => {
  const pub = `${privPath}.pub`;
  if (!fs.existsSync(pub)) return '';
  try {
    const [type, , comment = ''] = fs.readFileSync(pub, 'utf8').trim().split(/\s+/);
    return `${type}${comment ? `  ${comment}` : ''}`;
  } catch {
    return '';
  }
};

/** Scan ~/.ssh for private keys. Never prints key material. */
const findSshKeys = () => {
  if (!fs.existsSync(SSH_DIR)) return [];
  return fs
    .readdirSync(SSH_DIR)
    .filter((f) => !IGNORE.has(f) && !f.endsWith('.pub'))
    .map((f) => path.join(SSH_DIR, f))
    .filter((p) => fs.statSync(p).isFile() && looksLikePrivateKey(p))
    .map((p) => ({ path: p, desc: describeKey(p) }));
};

/** Prompt for a key: scanned keys, custom path, or ssh-agent default. */
const chooseKey = async () => {
  const keys = findSshKeys();
  const remembered = config.get('ssh_key');

  const choices = keys.map((k) => ({
    name: `${path.basename(k.path)}${k.desc ? chalk.gray(`  (${k.desc})`) : ''}`,
    value: k.path,
  }));
  choices.push(new inquirer.Separator());
  choices.push({ name: 'Use ssh-agent / default SSH config', value: null });
  choices.push({ name: 'Enter a custom key path…', value: '__custom__' });

  const { key } = await inquirer.prompt([{
    type: 'list',
    name: 'key',
    message: 'Select SSH key for this repo:',
    choices,
    default: remembered && choices.some((c) => c.value === remembered) ? remembered : undefined,
  }]);

  if (key !== '__custom__') return key;

  const { custom } = await inquirer.prompt([{
    type: 'input',
    name: 'custom',
    message: 'Path to private key:',
    validate: (v) => (fs.existsSync(v.replace(/^~/, os.homedir())) ? true : 'File not found'),
  }]);
  return custom.replace(/^~/, os.homedir());
};

const main = async () => {
  const repo = process.argv[2] || DEFAULT_REPO;
  const target =
    process.argv[3] || path.basename(repo).replace(/\.git$/, '');

  console.log(chalk.cyan(`Repo:   ${repo}`));
  console.log(chalk.cyan(`Target: ${target}\n`));

  const keyPath = await chooseKey();

  const env = { ...process.env };
  if (keyPath) {
    env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o IdentitiesOnly=yes`;
    config.set('ssh_key', keyPath);
    console.log(chalk.green(`✔ Using key: ${path.basename(keyPath)}\n`));
  } else {
    config.delete('ssh_key');
    console.log(chalk.green('✔ Using ssh-agent / default config\n'));
  }

  // Quick auth check before cloning.
  const check = ora('Testing SSH access to remote…').start();
  const host = repo.match(/@([^:]+):/)?.[1];
  if (host) {
    const r = spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', `git@${host}`], {
      env: { ...env, SSH_AUTH_SOCK: keyPath ? '' : process.env.SSH_AUTH_SOCK },
      encoding: 'utf8',
    });
    // GitHub returns exit 1 with a "successfully authenticated" banner.
    const out = `${r.stdout}${r.stderr}`;
    if (/successfully authenticated|Welcome to GitLab/i.test(out)) {
      check.succeed('SSH authentication OK');
    } else if (/Permission denied|publickey/i.test(out)) {
      check.fail('SSH authentication failed for that key');
      console.log(chalk.gray(out.trim()));
      process.exit(1);
    } else {
      check.warn('Could not verify auth (non-GitHub host?) — continuing');
    }
  } else {
    check.info('Not an SSH URL — skipping key check');
  }

  const spinner = ora(
    fs.existsSync(path.join(target, '.git')) ? 'Pulling latest…' : 'Cloning…'
  ).start();

  try {
    if (fs.existsSync(path.join(target, '.git'))) {
      execFileSync('git', ['-C', target, 'pull', '--ff-only'], { env, stdio: 'pipe' });
    } else {
      execFileSync('git', ['clone', repo, target], { env, stdio: 'pipe' });
    }
    spinner.succeed(`Repo ready at ./${target}`);
  } catch (err) {
    spinner.fail('Git operation failed');
    console.error(chalk.red(err.stderr?.toString() || err.message));
    process.exit(1);
  }

  // Offer to install deps if it's a Node project.
  if (fs.existsSync(path.join(target, 'package.json'))) {
    const { install } = await inquirer.prompt([{
      type: 'confirm',
      name: 'install',
      message: 'Run npm install?',
      default: true,
    }]);
    if (install) {
      const s = ora('Installing dependencies…').start();
      try {
        execFileSync('npm', ['install'], { cwd: target, stdio: 'pipe' });
        s.succeed('Dependencies installed');
      } catch (err) {
        s.fail('npm install failed');
        console.error(chalk.red(err.stderr?.toString() || err.message));
      }
    }
  }
};

main().catch((err) => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});
