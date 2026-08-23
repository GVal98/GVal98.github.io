// Гейт ноги на настоящих записях. Запуск: node musicRecognition/test/pose.test.mjs
//
// Кадры из measures/ отдаются в тот же PoseGate, который работает на телефоне, —
// подменены только часы и источник кадров. Записи размечены самим телефоном по
// расписанию, так что правильный ответ известен для каждой команды: чётные —
// «нога опущена», нечётные — «поднята». Первая команда особая: нога и так
// опущена, менять нечего, и события на ней быть не должно.
//
// Гейт на все три записи один: калибруется он на первой и с той же осью идёт
// дальше. Между записями телефон вынимали из кармана и убирали обратно — если
// направление переживает это, переживёт и обычный день.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PoseGate, POSE } from '../js/pose.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'measures');
const LBL_B = 3;   // нога поднята
const WINDOW = 4;  // с после команды: реакция на вибрацию плюс полторы секунды гейта

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const sessions = files.map((f) => ({ name: f, ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));

/** Прогон одной записи. Возвращает все события с их временем. */
function replay(gate, session) {
  const out = [];
  for (const s of session.samples) {
    const t = s[0] / 1000;
    const e = gate.push(t, s[1], s[2], s[3], Math.hypot(s[7], s[8], s[9]));
    // Состояние ноги снимаем на месте: к концу записи оно уже другое.
    if (e) out.push({ t, ...e, upNow: gate.up });
  }
  return out;
}

// Всё, что гейт счёл сменой позы. На три записи их 21, и каждая должна найтись.
const POSE_STEP = ['up', 'down', 'calibrating', 'calibrated'];
const all = [];

let failed = 0;
const fail = (msg) => { failed++; console.log(`  ПРОВАЛ: ${msg}`); };
const show = (v) => v.map((x) => x.toFixed(3)).join(' ');

// Один гейт на всё. Калибровка — на первой записи: до неё телефон кладут
// в карман и садятся, и это движение на несколько секунд должно отбраковаться
// само, не сойдя за поднятие ноги.
const gate = new PoseGate();
gate.calibrate();

for (let i = 0; i < sessions.length; i++) {
  const session = sessions[i];
  const cal = i === 0;
  console.log(`\n${session.name}  ${session.seconds.toFixed(0)} с, ${session.hz} Гц${cal ? '  (с калибровкой)' : ''}`);
  gate.arm();
  const events = replay(gate, session);
  all.push(...events);
  const acted = events.filter((e) => e.verdict === 'up' || e.verdict === 'down');

  if (cal) {
    const steps = events.filter((e) => e.verdict === 'calibrating' || e.verdict === 'calibrated');
    if (steps.length !== POSE.calSteps) fail(`калибровка съела ${steps.length} движений вместо ${POSE.calSteps}`);
    else console.log(`  ось ${show(gate.axis)} по ${steps.length} движениям`
      + `, повороты ${steps.map((e) => `${e.along.toFixed(1)}°`).join(' и ')}`);
    if (steps[steps.length - 1]?.upNow) fail('калибровка кончилась на поднятой ноге, а кончаться должна на опущенной');
    // Калибровку съели две первые смены позы — команды под ними спрашивать не с чего.
    session.cues.splice(1, POSE.calSteps);
  }

  const long = events.filter((e) => e.verdict === 'long');
  if (cal && !long.length) fail('укладка в карман не попала в отбраковку по длительности');

  const used = new Set();
  let hits = 0;
  session.cues.forEach(([atMs, label], k) => {
    const at = atMs / 1000;
    // Первая команда просит опустить ногу, а она и так опущена: менять нечего.
    const want = k === 0 ? null : label === LBL_B ? 'up' : 'down';
    const got = acted.filter((e) => e.t > at && e.t <= at + WINDOW);
    got.forEach((e) => used.add(e));
    if (want === null) {
      if (got.length) fail(`команда ${at} с менять позу не просила, а гейт отозвался: ${got.map((e) => e.verdict).join(', ')}`);
      return;
    }
    if (!got.length) return fail(`команда ${at} с (${want}) осталась без события`);
    if (got.length > 1) return fail(`команда ${at} с: событий ${got.length}, а поза менялась одна`);
    if (got[0].verdict !== want) return fail(`команда ${at} с: ${got[0].verdict} вместо ${want}`);
    hits++;
  });

  const extra = acted.filter((e) => !used.has(e));
  if (extra.length) fail(`лишние срабатывания: ${extra.map((e) => `${e.t.toFixed(1)} с ${e.verdict}`).join(', ')}`);

  const along = acted.map((e) => Math.abs(e.along));
  const lat = acted.map((e) => e.age);
  console.log(`  ${hits} смен позы из ${session.cues.length - 1}, лишних ${extra.length}`);
  if (along.length) {
    console.log(`  поворот вдоль оси ${Math.min(...along).toFixed(1)}…${Math.max(...along).toFixed(1)}°`
      + `, решение через ${Math.min(...lat).toFixed(1)}…${Math.max(...lat).toFixed(1)} с после начала движения`);
  }
  const skipped = events.filter((e) => !POSE_STEP.includes(e.verdict));
  if (skipped.length) {
    const by = {};
    for (const e of skipped) by[e.verdict] = (by[e.verdict] || 0) + 1;
    console.log('  отбраковано: ' + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', '));
  }
}

console.log(`\nОсь после трёх записей ${show(gate.axis)}`);

// Порог должен стоять в зазоре, а не впритык. Проверок две — на весь поворот и
// на то, сколько его легло вдоль оси, — и запас считается по обеим. По тому же
// прогону, что был выше: чужая ось — чужие проекции, и запас по ней ничей.
console.log('\nЗапас порогов');
{
  const steps = all.filter((e) => POSE_STEP.includes(e.verdict));
  // Всё, что дошло до сравнения поз и позой не оказалось. Укладка в карман
  // не в счёт: её отбраковала длительность, до сравнения дело не дошло.
  const noise = all.filter((e) => e.verdict === 'small' || e.verdict === 'across');
  const bar = POSE.minAngle * POSE.alongShare;
  console.log(`  ступенек поз ${steps.length}`);
  console.log(`  поворот целиком: самый слабый ${Math.min(...steps.map((e) => e.angle)).toFixed(2)}°`
    + ` при пороге ${POSE.minAngle}°`);
  console.log(`  вдоль оси:       самый слабый ${Math.min(...steps.map((e) => Math.abs(e.along))).toFixed(2)}°`
    + ` при пороге ${bar.toFixed(2)}°`);
  console.log(`  всё прочее, что дошло до сравнения: ${noise.length}`
    + (noise.length ? `, поворот до ${Math.max(...noise.map((e) => e.angle)).toFixed(2)}°` : ''));
  if (steps.length !== 21) fail(`ступенек поз ${steps.length}, а в трёх записях их 21`);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nOK');
process.exit(failed ? 1 : 0);
