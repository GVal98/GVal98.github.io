// Гейт ноги на настоящих записях. Запуск: node musicRecognition/test/pose.test.mjs
//
// Кадры из measures/ отдаются в тот же PoseGate, который работает на телефоне, —
// подменены только часы и источник кадров. Записи размечены самим телефоном по
// расписанию, так что правильный ответ известен для каждой команды: чётные —
// «нога опущена», нечётные — «поднята». Первая команда особая: нога и так
// опущена, менять нечего, и события на ней быть не должно.
//
// Гейт на все записи один: калибруется он на первой и с той же осью идёт
// дальше. Записи сняты в разные дни и из разных карманов, между ними телефон
// вынимали и убирали обратно — если направление переживает это, переживёт
// и обычный день. Второй карман здесь не для галочки: в нём нога крутит
// телефон вокруг вертикали, ступенька тяжести проседает до 0.11°, и гейт,
// сравнивавший векторы тяжести, слеп там наполовину. Набег вращения видит
// оба кармана одинаково.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PoseGate, POSE } from '../js/pose.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'measures');
const LBL_B = 3;   // нога поднята
// С после команды, за которые событие обязано прийти: секунда на реакцию,
// самое ленивое записанное движение (3.1 с) и решение гейта после него.
const WINDOW = 5.5;

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const sessions = files.map((f) => ({ name: f, ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
// Смен позы во всех записях вместе: каждая команда, кроме первой в записи.
const STEPS_TOTAL = sessions.reduce((n, s) => n + s.cues.length - 1, 0);

/** Прогон одной записи. Возвращает все события с их временем. */
function replay(gate, session) {
  const F = Object.fromEntries(session.fields.map((n, i) => [n, i]));
  const out = [];
  for (const s of session.samples) {
    const t = s[0] / 1000;
    const e = gate.push(t, s[F.rx], s[F.ry], s[F.rz]);
    // Состояние ноги снимаем на месте: к концу записи оно уже другое.
    if (e) out.push({ t, ...e, upNow: gate.up });
  }
  return out;
}

// Всё, что гейт счёл сменой позы. Каждая размеченная должна найтись.
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
      + `, набеги ${steps.map((e) => `${e.along.toFixed(1)}°`).join(' и ')}`);
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
    console.log(`  набег вдоль оси ${Math.min(...along).toFixed(1)}…${Math.max(...along).toFixed(1)}°`
      + `, решение через ${Math.min(...lat).toFixed(1)}…${Math.max(...lat).toFixed(1)} с после начала движения`);
  }
  const skipped = events.filter((e) => !POSE_STEP.includes(e.verdict));
  if (skipped.length) {
    const by = {};
    for (const e of skipped) by[e.verdict] = (by[e.verdict] || 0) + 1;
    console.log('  отбраковано: ' + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', '));
  }
}

console.log(`\nОсь после всех записей ${show(gate.axis)}`);

// Порог должен стоять в зазоре, а не впритык. Проверок две — на весь набег и
// на то, сколько его легло вдоль оси, — и запас считается по обеим. По тому же
// прогону, что был выше: чужая ось — чужие проекции, и запас по ней ничей.
console.log('\nЗапас порогов');
{
  const steps = all.filter((e) => POSE_STEP.includes(e.verdict));
  // Всё, что дошло до сравнения и позой не оказалось. Укладка в карман
  // не в счёт: её отбраковала длительность, до сравнения дело не дошло.
  const noise = all.filter((e) => e.verdict === 'small' || e.verdict === 'across');
  const bar = POSE.minAngle * POSE.alongShare;
  console.log(`  ступенек поз ${steps.length}`);
  console.log(`  набег целиком: самый слабый ${Math.min(...steps.map((e) => e.angle)).toFixed(2)}°`
    + ` при пороге ${POSE.minAngle}°`);
  console.log(`  вдоль оси:     самый слабый ${Math.min(...steps.map((e) => Math.abs(e.along))).toFixed(2)}°`
    + ` при пороге ${bar.toFixed(2)}°`);
  console.log(`  всё прочее, что дошло до сравнения: ${noise.length}`
    + (noise.length ? `, набег до ${Math.max(...noise.map((e) => e.angle)).toFixed(2)}°` : ''));
  if (steps.length !== STEPS_TOTAL) fail(`ступенек поз ${steps.length}, а в записях их ${STEPS_TOTAL}`);
}

// Набег под мотором: ступенька из-под работающей морзянки.
//
// Гоняется по тем же записям, и спрашивается по ним ровно то, что они знают:
// ловится ли ступенька, когда обычный путь выключен слепотой, и не ловится ли
// она там, где позу менять не просили. Слепота здесь ставится руками — так же,
// как её ставит морзянка: за секунду до движения и на всё, что после.
//
// Чего записи не знают: как ведёт себя гироскоп под десятью секундами мотора
// подряд. Их собственная вибрация — полсекунды на команду, и за неё набег
// не превышает 0.2° при пороге 3.5°. См. README, «Чего про ногу неизвестно».
console.log('\nНабег под мотором');
{
  const axis = gate.axis;
  const shade = 1.0;   // за сколько секунд до движения включается мотор
  const took = [];     // всё, что сторож взял из-под мотора
  let quiet = 0;

  for (const session of sessions) {
    const F = Object.fromEntries(session.fields.map((n, i) => [n, i]));
    const rows = session.samples.map((r) => [r[0] / 1000, r[F.rx], r[F.ry], r[F.rz]]);
    // Где на этой записи настоящие ступеньки — по обычному пути, без слепоты.
    const plain = new PoseGate({ axis });
    plain.arm();
    const steps = [];
    for (const r of rows) {
      const e = plain.push(...r);
      if (e && (e.verdict === 'up' || e.verdict === 'down')) {
        // `end` — когда движение кончилось по самому гейту: тихий отрезок
        // после ступеньки можно начинать только за ним, а не по расписанию —
        // самая ленивая смена позы тянется три секунды.
        steps.push({ from: r[0] - e.age, end: r[0] - e.age + e.moveSec, verdict: e.verdict, up: plain.up });
      }
    }

    /** Прогон с ослеплением в `blindAt` на `sec` секунд. */
    const underMotor = (up, from, blindAt, sec) => {
      const g = new PoseGate({ axis });
      g.arm();
      g.up = up;
      const out = [];
      let blinded = false;
      for (const r of rows) {
        if (r[0] < from) continue;
        if (!blinded && r[0] >= blindAt) { g.blind(sec); blinded = true; }
        const e = g.push(...r);
        if (e) out.push({ t: r[0], ...e });
      }
      return { out, blinded };
    };

    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const { out, blinded } = underMotor(!st.up, st.from - 3, st.from - shade, 12);
      if (!blinded) continue;
      const got = out.filter((e) => e.underMotor);
      if (!got.length) fail(`${session.name}: ступенька на ${st.from.toFixed(1)} с потерялась под мотором`);
      else if (got.length > 1) fail(`${session.name}: ступенька на ${st.from.toFixed(1)} с ушла ${got.length} раза`);
      else if (got[0].verdict !== st.verdict) fail(`${session.name}: под мотором ${got[0].verdict} вместо ${st.verdict}`);
      else took.push({ ...got[0], lag: got[0].t - st.from });

      // Тот же мотор, но там, где поза не менялась: от конца этой ступеньки
      // до начала следующей.
      const till = (steps[i + 1]?.from ?? rows[rows.length - 1][0]) - 1.5;
      const rest = till - (st.end + 1.5);
      if (rest < POSE.blindWin * 2) continue;
      const still = underMotor(st.up, st.end + 0.5, st.end + 1.5, rest);
      if (still.out.some((e) => e.underMotor)) {
        fail(`${session.name}: сторож нашёл ступеньку там, где позу не меняли (${st.from.toFixed(1)} с +${rest.toFixed(1)} с)`);
      } else quiet++;
    }
  }
  console.log(`  поймано под мотором ${took.length} ступенек из ${STEPS_TOTAL}, тихих отрезков без ложных ${quiet}`);
  if (took.length) {
    console.log(`  набег целиком ${Math.min(...took.map((e) => e.angle)).toFixed(2)}…${Math.max(...took.map((e) => e.angle)).toFixed(2)}°`
      + `, вдоль оси ${Math.min(...took.map((e) => Math.abs(e.along))).toFixed(2)}…${Math.max(...took.map((e) => Math.abs(e.along))).toFixed(2)}°`);
    console.log(`  мотор смолкает через ${Math.min(...took.map((e) => e.lag)).toFixed(1)}…${Math.max(...took.map((e) => e.lag)).toFixed(1)} с после начала движения`);
  }
  if (took.length < STEPS_TOTAL) fail(`под мотором поймано ${took.length} ступенек, а в записях их ${STEPS_TOTAL}`);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nOK');
process.exit(failed ? 1 : 0);
