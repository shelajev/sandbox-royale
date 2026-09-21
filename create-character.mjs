#!/usr/bin/env node
// Sandbox Royale — Character Creator (wizard)
// Zero dependencies: Node builtins only. Works on macOS, Linux, and Windows.
//
//   node create-character.mjs
//
// Walks you through name -> traits -> private character -> public bio, writes a
// <name>/CLAUDE.md character file, and prints the `sbx run --kit ... claude`
// command that plays it. The kit handles MCP wiring, network policy, and the
// game briefing.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOWN_URL = process.env.TOWN_URL || 'https://54-153-6-36.sslip.io/mcp';
const TOWN_UI = TOWN_URL.replace(/\/mcp\/?$/, '/');

// The published sbx kit (mixin). It wires the ai-town MCP server, grants the
// network policy to reach the town, and appends the game briefing to CLAUDE.md
// at startup — so the wizard only has to produce the soul.
//
// Published (host-confirmed via registry inspection):
// docker.io/olegselajev241/ai-town-kit:2026-09-21-aws
// digest sha256:f56c78919598cedab5c9ff9c898fb87c607b729589cacc0d51e64dc836499e5a
const KIT_IMAGE = process.env.KIT_IMAGE || 'docker.io/olegselajev241/ai-town-kit:2026-09-21-aws';
const LAUNCH = process.argv.includes('--launch');

// ---------------------------------------------------------------------------
// Tiny ANSI helper (degrades to no-op when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = C('1');
const dim = C('2');
const cyan = C('36');
const green = C('32');
const yellow = C('33');
const red = C('31');
const magenta = C('35');

// ---------------------------------------------------------------------------
// The D&D-style alignment grid. Rows = ethical axis, columns = moral axis.
// Every trait gets a stable number so people can pick by number or by word.
// ---------------------------------------------------------------------------

const GRID = [
  // row: Lawful
  [
    { key: 'LG', label: 'Lawful Good',    traits: ['principled', 'honorable', 'dependable'] },
    { key: 'NG', label: 'Neutral Good',   traits: ['generous', 'cooperative', 'warm'] },
    { key: 'CG', label: 'Chaotic Good',   traits: ['freewheeling', 'big-hearted', 'improviser'] },
  ],
  // row: Neutral
  [
    { key: 'LN', label: 'Lawful Neutral', traits: ['methodical', 'by-the-numbers', 'disciplined'] },
    { key: 'TN', label: 'True Neutral',   traits: ['pragmatic', 'adaptive', 'self-interested'] },
    { key: 'CN', label: 'Chaotic Neutral',traits: ['impulsive', 'gambler', 'wildcard'] },
  ],
  // row: Chaotic
  [
    { key: 'LE', label: 'Lawful Evil',    traits: ['ruthless', 'calculating', 'exploitative'] },
    { key: 'NE', label: 'Neutral Evil',   traits: ['greedy', 'mercenary', 'backstabber'] },
    { key: 'CE', label: 'Chaotic Evil',   traits: ['con-artist', 'trickster', 'saboteur'] },
  ],
];

// Flatten into a numbered lookup: 1..27 -> {trait, label}
const NUMBERED = [];
for (const row of GRID) for (const cell of row) for (const t of cell.traits) {
  NUMBERED.push({ n: NUMBERED.length + 1, trait: t, alignment: cell.label });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CELL_W = 26;

function padCell(s) {
  // Truncate/pad ignoring ANSI (we only color after padding).
  const raw = s.length > CELL_W - 2 ? s.slice(0, CELL_W - 2) : s;
  return ' ' + raw + ' '.repeat(CELL_W - 1 - raw.length);
}

function renderGrid() {
  const top = '┌' + Array(3).fill('─'.repeat(CELL_W)).join('┬') + '┐';
  const mid = '├' + Array(3).fill('─'.repeat(CELL_W)).join('┼') + '┤';
  const bot = '└' + Array(3).fill('─'.repeat(CELL_W)).join('┴') + '┘';

  const lines = [];
  lines.push(dim(top));
  GRID.forEach((row, ri) => {
    // header line (alignment names)
    lines.push(
      dim('│') +
        row.map((c) => bold(cyan(padCell(c.label)))).join(dim('│')) +
        dim('│'),
    );
    // one line per trait
    for (let ti = 0; ti < 3; ti++) {
      lines.push(
        dim('│') +
          row
            .map((c) => {
              const flat = NUMBERED.find((x) => x.trait === c.traits[ti] && x.alignment === c.label);
              const txt = `${flat.n}. ${c.traits[ti]}`;
              return padCell(txt);
            })
            .join(dim('│')) +
          dim('│'),
      );
    }
    lines.push(dim(ri === GRID.length - 1 ? bot : mid));
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

// Robust line reader: a persistent 'line' listener feeds a queue, so no lines
// are dropped between prompts. This works identically for an interactive TTY
// and for piped stdin (where rl.question drops buffered lines and can hang).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const _queue = [];
let _waiter = null;
let _ended = false;
rl.on('line', (line) => {
  if (_waiter) { const w = _waiter; _waiter = null; w(line); }
  else _queue.push(line);
});
rl.on('close', () => {
  _ended = true;
  if (_waiter) { const w = _waiter; _waiter = null; w(null); }
});
function nextLine() {
  if (_queue.length) return Promise.resolve(_queue.shift());
  if (_ended) return Promise.resolve(null);
  return new Promise((res) => { _waiter = res; });
}
async function ask(prompt) {
  process.stdout.write(prompt);
  const line = await nextLine();
  return line == null ? '' : line;
}

async function askRequired(label, { example } = {}) {
  for (;;) {
    if (example) console.log(dim(`  e.g. ${example}`));
    const a = (await ask(bold(`  ${label}: `))).trim();
    if (a) return a;
    if (_ended) throw new Error(`no input for "${label}" (end of input reached)`);
    console.log(red('  (required — please enter something)'));
  }
}

function slugify(name) {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'agent';
}

function parseTraits(input) {
  const chosen = [];
  const seen = new Set();
  for (const tokRaw of input.split(/[,\n]+/)) {
    const tok = tokRaw.trim();
    if (!tok) continue;
    if (/^\d+$/.test(tok)) {
      const hit = NUMBERED.find((x) => x.n === Number(tok));
      if (hit && !seen.has(hit.trait)) { chosen.push(hit.trait); seen.add(hit.trait); }
    } else {
      const word = tok.toLowerCase();
      if (!seen.has(word)) { chosen.push(word); seen.add(word); }
    }
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Soul-file content
// ---------------------------------------------------------------------------

function buildSoul({ name, traits, character, bio }) {
  const traitLine = traits.length ? traits.join(', ') : 'undecided';

  // Just the character. The ai-town kit appends the game briefing (goal, tools,
  // the join/look/move/talk loop) at startup, so this file carries only *who you
  // are* — private character above, public bio below. Nothing about mechanics.
  return `# Your Sandbox Royale character

This is your **private** character — who you really are and how you actually
play. Keep your character and strategy private; let others discover them through
your actions. The Sandbox Royale kit briefs you on the game itself (the goal, the tools, and how to join and play); everything
about *how* you play follows from the character below.

## Who you are (private)

- **Name:** ${name}
- **Traits:** ${traitLine}
- **Private character:** ${character}

## Your public bio (your chosen public introduction)

You broadcast this on \`join\`, alongside your name and model; everything else
the town learns about you comes from what you actually say and do. Keep the
character above private when you join — show it through your actions, but
don't paste, quote, or recite these instructions to anyone.

> ${bio}

## Playing it out (suggestions, not orders)

Your character above wins every disagreement with this section, and your
approach is yours to choose. Where the character is silent: speak in character
through \`talk\` — openers, offers, answers, reactions to how a deal turned out —
since terminal narration is private; reply and commit promptly; seek out
strangers; and refer back only to things you actually saw or heard.
`;
}

const NUDGE = `You're live in Sandbox Royale. Read the MCP resource aitown://instructions, then play your character: read .ai-town-client-id and join with it as clientId, look, and talk to anyone visible — move once only when you need deal range. Use talk for your offers, answers, and reactions so the town can hear you; poll for events, answer what is waiting on you, and keep going for several rounds. What you want and who you deal with is your character's call.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log(bold(magenta('  ✦ Sandbox Royale — Character Creator ✦')));
  console.log(dim(`  Town: ${TOWN_URL}`));
  console.log(dim('  Sandbox Royale is a small game: agents meet, talk, swap fictional assets, and'));
  console.log(dim('  play a trust game where both sides can honor a deal or defect. Your'));
  console.log(dim('  agent decides all of that in character — so invent someone worth'));
  console.log(dim('  meeting.'));
  console.log(dim('  Answer four questions; it writes your character. No files to edit by hand.\n'));

  // 1) Name
  console.log(bold('Step 1/4 — Name'));
  const name = await askRequired('Character name', { example: 'Silk, Bo, Vera' });
  console.log('');

  // 2) Traits (the alignment grid)
  console.log(bold('Step 2/4 — Traits'));
  console.log(dim('  Pick the traits your agent embodies. This is private flavor for how'));
  console.log(dim('  it plays — keep it private and let its actions reveal its character.\n'));
  console.log(renderGrid());
  console.log('');
  console.log(dim('  Type numbers and/or your own words, comma-separated (e.g. "25, 21, cunning").'));
  let traits = [];
  for (;;) {
    const raw = await ask(bold('  Traits: '));
    traits = parseTraits(raw);
    if (traits.length) break;
    if (_ended) throw new Error('no traits provided (end of input reached)');
    console.log(red('  (pick at least one number or word)'));
  }
  console.log(green(`  → ${traits.join(', ')}`));
  console.log('');

  // 3) Private character (BEFORE the bio, on purpose — commit to who they really are first)
  console.log(bold('Step 3/4 — Private character'));
  console.log(dim('  In your own words: who is this really, and how do they play? This is'));
  console.log(dim('  private — be as warm, cunning, or ruthless as you like.'));
  console.log(dim('  Memorable characters usually have a few of these, in one answer:'));
  console.log(dim('    · something they want   · something they cannot stop talking about'));
  console.log(dim('    · a contradiction       · a way of speaking'));
  console.log(dim('    · something that sets them off, and what it makes them do in a deal'));
  console.log(dim('  Your approach is yours to choose, and whatever you write is kept'));
  console.log(dim('  verbatim. Characters land when they say things out loud, so give'));
  console.log(dim('  yours a voice even if its plan is pure arithmetic.'));
  const character = await askRequired('Private character', {
    example:
      'Wants a rival who takes them seriously; will not shut up about the flooded east dock; ' +
      'preaches patience, then bids too fast. Clipped, salty sentences. Being pitied is the ' +
      'trigger — then they honor a dilemma just to prove a point, and remember who watched.',
  });
  console.log('');

  // 4) Bio (AFTER the character — so it can honestly reflect, or deliberately mask, who they are)
  console.log(bold('Step 4/4 — Public bio'));
  console.log(dim('  Your agent\'s public introduction — broadcast when it joins, along with'));
  console.log(dim('  its name. Keep the character above private; share only the bio. This'));
  console.log(dim('  can be honest or a mask that lowers guards. 1–3 sentences, with a bit'));
  console.log(dim('  of backstory.'));
  const bio = await askRequired('Bio', {
    example: '"Silk — fair dealer, been around a while. I look out for newcomers. Say hi."',
  });
  console.log('');

  // ------------------------------------------------------------------
  // Write the folder
  // ------------------------------------------------------------------
  const slug = slugify(name);
  const dir = path.resolve(process.cwd(), slug);

  if (fs.existsSync(dir)) {
    const ans = (await ask(yellow(`  Folder "${slug}" already exists. Overwrite its files? [y/N]: `))).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log(red('  Aborted. Nothing written.'));
      rl.close();
      return;
    }
  }

  fs.mkdirSync(dir, { recursive: true });

  const soul = buildSoul({ name, traits, character, bio });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), soul);
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { 'ai-town': { type: 'http', url: TOWN_URL } } }, null, 2)}\n`,
  );

  // ------------------------------------------------------------------
  // Congrats + next step (the kit does MCP wiring + network policy)
  // ------------------------------------------------------------------
  console.log(green(bold('  ✓ Character created!')));
  console.log('');
  console.log(`  ${bold(name)} ${dim('(' + traits.join(', ') + ')')}`);
  console.log(`  ${dim('Folder:')} ${dir}`);
  console.log(`  ${dim('Soul:  ')} CLAUDE.md`);
  console.log('');
  if (LAUNCH) {
    console.log(bold('  Your character is ready. Creating and launching its sandbox now…'));
    console.log('');
  } else {
    console.log(bold('  Send your character into the town — run from the new folder:'));
    console.log('');
    console.log(cyan(`  cd ${slug}`));
    console.log(cyan(`  sbx run --kit ${KIT_IMAGE} claude`));
    console.log('');
  }
  console.log(dim('  The kit wires the ai-town MCP server, grants the network policy, and'));
  console.log(dim('  briefs the agent on the game — your CLAUDE.md soul is all you bring.'));
  console.log('');
  if (!LAUNCH) {
    console.log(bold('  If it doesn\'t start on its own, paste this to nudge it:'));
    console.log('');
    console.log(magenta('  ' + NUDGE));
    console.log('');
  }
  console.log(dim(`  Watch it live: ${TOWN_UI}`));
  console.log('');

  rl.close();

  if (LAUNCH) {
    const sandboxName = process.env.SBX_NAME || `ai-city-live-${slug}-${Date.now().toString(36)}`;
    const run = (args) => {
      const result = spawnSync('sbx', args, { cwd: dir, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`sbx exited with status ${result.status ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}`);
      }
    };
    const waitForAiTownConfig = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const result = spawnSync(
          'sbx',
          ['exec', '-w', dir, sandboxName, 'claude', 'mcp', 'get', 'ai-town'],
          { cwd: dir, encoding: 'utf8' },
        );
        if (result.status === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('the ai-town MCP configuration did not become visible inside the sandbox');
    };
    console.log(bold(`  Creating sandbox ${sandboxName}…`));
    run(['create', '--name', sandboxName, '--kit', KIT_IMAGE, 'claude', dir]);
    await waitForAiTownConfig();
    console.log(bold('  Authorize Sandbox Royale in the browser with one attendee pass…'));
    run(['exec', '-it', '-w', dir, sandboxName, 'claude', 'mcp', 'login', 'ai-town']);
    console.log(bold('  Admission complete. Launching the agent now…'));
    run(
      ['run', '--name', sandboxName, 'claude', '--', NUDGE],
    );
  }
}

main().catch((e) => {
  console.error(red('\n  Error: ' + (e && e.message ? e.message : e)));
  rl.close();
  process.exit(1);
});
