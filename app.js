'use strict';

/* ====================================================================
 * 手術記録アプリ (ope-note) — Phase 1
 * ローカル完結。外部通信なし。データは IndexedDB に保存。
 * ==================================================================== */

const DB_NAME = 'openote';
const DB_VERSION = 4;

/* 選択式項目の定義: key=マスタのカテゴリ, field=記録レコードのフィールド名 */
const CATEGORIES = [
  { key: 'sex',        label: '性別',       field: 'sex' },
  { key: 'side',       label: '左右',       field: 'side' },
  { key: 'diagnosis',  label: '疾患名',     field: 'diagnosis' },
  { key: 'crowe',      label: 'Crowe分類',  field: 'croweGroup' },
  { key: 'surgeon',    label: '執刀医',     field: 'surgeon' },
  { key: 'approach',   label: 'アプローチ', field: 'approach' },
  { key: 'cup',          label: 'Cup 商品名', field: 'cupName' },
  { key: 'liner',        label: 'Liner',      field: 'linerType' },
  { key: 'stem',         label: 'Stem 商品名', field: 'stemName' },
  { key: 'headMaterial', label: 'Head 素材',  field: 'headMaterial' },
  { key: 'navigation',   label: 'Navigation', field: 'navigationName' },
];

/* PROMsタブ専用の選択式カテゴリ。records入力フォーム・records取込には出さないため
   CATEGORIESとは分離し、マスタ初期化・設定画面でのみ ALL_CATEGORIES として結合する。 */
const PROMS_CATEGORIES = [
  { key: 'timepoint', label: '時点', field: 'timepoint' },
];
const ALL_CATEGORIES = CATEGORIES.concat(PROMS_CATEGORIES);

/* チップ（ボタン）表示にするカテゴリ。それ以外はプルダウン */
const CHIP_CATS = ['sex', 'side', 'crowe'];

/* 初回起動時に投入する選択肢 */
const DEFAULT_OPTIONS = {
  sex:        ['M', 'F'],
  side:       ['Rt', 'Lt', '両側'],
  diagnosis:  ['変形性股関節症', '大腿骨頭壊死症', '関節リウマチ', '大腿骨頸部骨折', 'その他'],
  crowe:      ['Group I', 'Group II', 'Group III', 'Group IV'],
  surgeon:    [],
  approach:   ['前方 (DAA)', '前側方 (ALS)', '後側方', 'その他'],
  cup:          [],
  liner:        [],
  stem:         [],
  headMaterial: [],
  navigation:   ['NaviSwiss', 'なし'],
  timepoint:    ['術前', '術後3M', '術後6M', '術後1Y'],
};

let db = null;
let masters = {};          // { category: [optionObj, ...] } sortOrder順
let editingUuid = null;    // 編集中レコードのUUID（新規時はnull）
let editingMeta = null;    // 編集中レコードの createdAt 等を保持
let selectMode = false;
let selectedUuids = new Set();
let editingPromsUuid = null;  // 編集中PROMsのUUID（新規時はnull）
let editingPromsMeta = null;  // 編集中PROMsの createdAt 等を保持

/* ============================ IndexedDB ============================ */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('records')) {
        const rec = d.createObjectStore('records', { keyPath: 'uuid' });
        rec.createIndex('surgeryDate', 'surgeryDate');
      }
      if (!d.objectStoreNames.contains('masterOptions')) {
        const opt = d.createObjectStore('masterOptions', { keyPath: 'id', autoIncrement: true });
        opt.createIndex('category', 'category');
      }
      // v2: 登録番号(recordNo)の永続カウンタなどを保持する meta ストア
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
      // v4: PROMs（算出済みスコアの縦断登録）ストア。contains ガードにより
      // 新規インストール(oldVersion 0)・既存更新(3→4)の両方を安全にカバーする。
      if (!d.objectStoreNames.contains('proms')) {
        const pr = d.createObjectStore('proms', { keyPath: 'uuid' });
        pr.createIndex('patientID', 'patientID');
      }
      // v3: 性別 男性→M/女性→F、左右 右→Rt/左→Lt の値移行
      if (e.oldVersion > 0 && e.oldVersion < 3) {
        const sexMap  = { '男性': 'M', '女性': 'F' };
        const sideMap = { '右': 'Rt', '左': 'Lt' };
        const t3 = e.target.transaction;
        const migrate = (storeName, fn) => {
          t3.objectStore(storeName).openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) return;
            fn(cur);
            cur.continue();
          };
        };
        migrate('records', (cur) => {
          const r = cur.value;
          if (sexMap[r.sex] || sideMap[r.side]) {
            if (sexMap[r.sex])  r.sex  = sexMap[r.sex];
            if (sideMap[r.side]) r.side = sideMap[r.side];
            cur.update(r);
          }
        });
        migrate('masterOptions', (cur) => {
          const o = cur.value;
          if (o.category === 'sex'  && sexMap[o.value])  { o.value = sexMap[o.value];  cur.update(o); }
          if (o.category === 'side' && sideMap[o.value]) { o.value = sideMap[o.value]; cur.update(o); }
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbRequest(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbGetAll = (s)      => dbRequest(s, 'readonly',  (st) => st.getAll());
const dbGet    = (s, key) => dbRequest(s, 'readonly',  (st) => st.get(key));
const dbPut    = (s, val) => dbRequest(s, 'readwrite', (st) => st.put(val));
const dbDelete = (s, key) => dbRequest(s, 'readwrite', (st) => st.delete(key));

/* ---------- meta（登録番号カウンタ等の永続値） ---------- */
async function getMeta(key, def) {
  const row = await dbGet('meta', key);
  return row ? row.value : def;
}
async function setMeta(key, value) {
  await dbRequest('meta', 'readwrite', (st) => st.put({ key, value }));
}

/* 新規保存用に登録番号を1つ払い出す（払い出した番号は二度と再利用しない） */
async function allocRecordNo() {
  const n = await getMeta('nextRecordNo', 1);
  await setMeta('nextRecordNo', n + 1);
  return n;
}

/* 既存記録に登録番号が無いものへ採番し、カウンタを最大値+1に整える（初回起動・マージ後の保険） */
async function backfillRecordNos() {
  const recs = await dbGetAll('records');
  const maxNo = recs.reduce((m, r) => Math.max(m, Number(r.recordNo) || 0), 0);
  let next = await getMeta('nextRecordNo', 1);
  if (next <= maxNo) next = maxNo + 1;
  const missing = recs.filter((r) => !r.recordNo).sort((a, b) =>
    (a.surgeryDate || '').localeCompare(b.surgeryDate || '') ||
    (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const r of missing) { r.recordNo = next++; await dbPut('records', r); }
  await setMeta('nextRecordNo', next);
}

/* ============================ ユーティリティ ============================ */

function genUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deviceName() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iphone' : 'mac';
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 1800);
}

function numOrNull(v) {
  return v === '' ? null : Number(v);
}

/* ============================ マスタ読み込み ============================ */

async function loadMasters() {
  const all = await dbGetAll('masterOptions');
  masters = {};
  for (const c of ALL_CATEGORIES) masters[c.key] = [];
  for (const o of all) {
    if (masters[o.category]) masters[o.category].push(o);
  }
  for (const k of Object.keys(masters)) {
    masters[k].sort((a, b) => a.sortOrder - b.sortOrder);
  }
}

async function seedDefaultsIfEmpty() {
  const all = await dbGetAll('masterOptions');
  if (all.length > 0) return;
  for (const [category, values] of Object.entries(DEFAULT_OPTIONS)) {
    for (let i = 0; i < values.length; i++) {
      await dbPut('masterOptions', { category, value: values[i], sortOrder: i, isActive: true });
    }
  }
}

/* 既存ユーザー（masterOptionsが既に存在しseedDefaultsIfEmptyが発火しない）にも
   新カテゴリ(timepoint)の既定選択肢を確実に投入する。該当カテゴリが空の時だけ実行。 */
async function seedCategoryIfEmpty(category) {
  const all = await dbGetAll('masterOptions');
  if (all.some((o) => o.category === category)) return;
  const values = DEFAULT_OPTIONS[category] || [];
  for (let i = 0; i < values.length; i++) {
    await dbPut('masterOptions', { category, value: values[i], sortOrder: i, isActive: true });
  }
}

/* ============================ フォーム描画 ============================ */

function activeValues(catKey) {
  return masters[catKey].filter((o) => o.isActive !== false).map((o) => o.value);
}

/* チップ・プルダウンをマスタから再構築（現在の選択値は維持する） */
function renderFormControls() {
  for (const c of CATEGORIES) {
    if (CHIP_CATS.includes(c.key)) {
      const box = document.getElementById(`chips-${c.key}`);
      const current = box.dataset.value || '';
      box.innerHTML = '';
      for (const v of activeValues(c.key)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip' + (v === current ? ' selected' : '');
        btn.textContent = v;
        btn.addEventListener('click', () => selectChip(box, v));
        box.appendChild(btn);
      }
      // 選択中の値がマスタから消えていてもデータは保持する
      if (current && !activeValues(c.key).includes(current)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip selected chip-orphan';
        btn.textContent = current;
        btn.addEventListener('click', () => selectChip(box, current));
        box.appendChild(btn);
      }
    } else {
      const sel = document.getElementById(`f-${c.key}`);
      const current = sel.value;
      sel.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '未選択';
      sel.appendChild(empty);
      for (const v of activeValues(c.key)) {
        const op = document.createElement('option');
        op.value = v;
        op.textContent = v;
        sel.appendChild(op);
      }
      setSelectValue(sel, current);
    }
  }
}

/* 選択肢に存在しない値でも option を補って表示する（マスタ削除後の過去記録対策） */
function setSelectValue(sel, value) {
  if (!value) { sel.value = ''; return; }
  if (![...sel.options].some((o) => o.value === value)) {
    const op = document.createElement('option');
    op.value = value;
    op.textContent = `${value}（マスタ未登録）`;
    sel.appendChild(op);
  }
  sel.value = value;
}

function selectChip(box, value) {
  // 同じチップを再タップで選択解除
  box.dataset.value = (box.dataset.value === value) ? '' : value;
  for (const btn of box.querySelectorAll('.chip')) {
    btn.classList.toggle('selected', btn.textContent === box.dataset.value);
  }
}

function setChipValue(catKey, value) {
  const box = document.getElementById(`chips-${catKey}`);
  box.dataset.value = value || '';
  renderFormControls();
}

/* ============================ フォーム値の収集・反映 ============================ */

function collectForm() {
  const rec = {
    surgeryDate:      document.getElementById('f-date').value,
    patientID:        document.getElementById('f-patientId').value.trim(),
    age:              numOrNull(document.getElementById('f-age').value),
    heightCm:         numOrNull(document.getElementById('f-height').value),
    weightKg:         numOrNull(document.getElementById('f-weight').value),
    operationTimeMin: numOrNull(document.getElementById('f-opTime').value),
    bloodLossML:      numOrNull(document.getElementById('f-bloodLoss').value),
    cupSize:          document.getElementById('f-cupSize').value.trim(),
    stemSize:         document.getElementById('f-stemSize').value.trim(),
    headSize:         document.getElementById('f-headSize').value.trim(),
    navRI:            document.getElementById('f-navRI').value.trim(),
    navRA:            document.getElementById('f-navRA').value.trim(),
    measuredRI:       document.getElementById('f-measuredRI').value.trim(),
    measuredRA:       document.getElementById('f-measuredRA').value.trim(),
    memo:             document.getElementById('f-memo').value,
    operativeNote:    document.getElementById('f-operativeNote').value,
  };
  for (const c of CATEGORIES) {
    if (CHIP_CATS.includes(c.key)) {
      rec[c.field] = document.getElementById(`chips-${c.key}`).dataset.value || '';
    } else {
      rec[c.field] = document.getElementById(`f-${c.key}`).value;
    }
  }
  return rec;
}

function fillForm(rec) {
  document.getElementById('f-date').value      = rec.surgeryDate || '';
  document.getElementById('f-patientId').value = rec.patientID || '';
  document.getElementById('f-age').value       = rec.age ?? '';
  document.getElementById('f-height').value    = rec.heightCm ?? '';
  document.getElementById('f-weight').value    = rec.weightKg ?? '';
  updateBMIDisplay();
  document.getElementById('f-opTime').value    = rec.operationTimeMin ?? '';
  document.getElementById('f-bloodLoss').value = rec.bloodLossML ?? '';
  document.getElementById('f-cupSize').value   = rec.cupSize || '';
  document.getElementById('f-stemSize').value  = rec.stemSize || '';
  document.getElementById('f-headSize').value  = rec.headSize || '';
  document.getElementById('f-navRI').value      = rec.navRI || '';
  document.getElementById('f-navRA').value      = rec.navRA || '';
  document.getElementById('f-measuredRI').value = rec.measuredRI || '';
  document.getElementById('f-measuredRA').value = rec.measuredRA || '';
  document.getElementById('f-memo').value          = rec.memo || '';
  document.getElementById('f-operativeNote').value = rec.operativeNote || '';
  for (const c of CATEGORIES) {
    if (CHIP_CATS.includes(c.key)) {
      document.getElementById(`chips-${c.key}`).dataset.value = rec[c.field] || '';
    } else {
      setSelectValue(document.getElementById(`f-${c.key}`), rec[c.field] || '');
    }
  }
  renderFormControls();
}

function updateBMIDisplay() {
  const bmi = bmiOf(document.getElementById('f-height').value,
                    document.getElementById('f-weight').value);
  document.getElementById('f-bmi').value = bmi ?? '';
}

function clearForm() {
  editingUuid = null;
  editingMeta = null;
  fillForm({ surgeryDate: todayStr() });
  document.getElementById('form-mode-label').textContent = '新規記録';
  document.getElementById('btn-new').hidden = true;
  document.getElementById('btn-duplicate').hidden = true;
}

/* 既存記録（または現在のフォーム内容）を引き継いだ「未保存の新規入力」にする。
   保存するとUUID・登録番号が新規採番される。両側症例で右→左を作る用途。 */
function enterDuplicateMode(srcRec) {
  editingUuid = null;
  editingMeta = null;
  fillForm(srcRec);
  document.getElementById('form-mode-label').textContent = '新規記録（複製・未保存）';
  document.getElementById('btn-new').hidden = false;
  document.getElementById('btn-duplicate').hidden = true;
  switchView('form');
  window.scrollTo({ top: 0 });
  toast('複製しました。左右など違う項目を直して保存してください');
}

/* ============================ 保存・編集・削除 ============================ */

async function saveRecord() {
  const rec = collectForm();
  if (!rec.surgeryDate) { toast('手術日を入力してください'); return; }

  const now = new Date().toISOString();
  if (editingUuid) {
    rec.uuid = editingUuid;
    rec.createdAt = editingMeta.createdAt;
    rec.createdDevice = editingMeta.createdDevice;
    rec.syncedAt = null; // 編集したら未送信に戻す（修正をMacへ再伝播させるため）
    rec.recordNo = editingMeta.recordNo; // 登録番号は編集で変えない
  } else {
    rec.uuid = genUUID();
    rec.createdAt = now;
    rec.createdDevice = deviceName();
    rec.syncedAt = null;
    rec.recordNo = await allocRecordNo();
  }
  rec.updatedAt = now;

  await dbPut('records', rec);
  toast(editingUuid ? '更新しました' : '保存しました');
  clearForm();
  await refreshCount();
  await renderList();
}

async function editRecord(rec) {
  editingUuid = rec.uuid;
  editingMeta = { createdAt: rec.createdAt, createdDevice: rec.createdDevice, syncedAt: rec.syncedAt, recordNo: rec.recordNo };
  fillForm(rec);
  document.getElementById('form-mode-label').textContent =
    `編集中: 登録No.${rec.recordNo ?? '－'} / ${rec.surgeryDate} / ID ${rec.patientID || '－'}`;
  document.getElementById('btn-new').hidden = false;
  document.getElementById('btn-duplicate').hidden = false;
  switchView('form');
  window.scrollTo({ top: 0 });
}

async function deleteRecord(rec) {
  const label = `${rec.surgeryDate} / ID ${rec.patientID || '－'} / ${rec.diagnosis || ''}`;
  if (!confirm(`この記録を削除しますか？\n${label}`)) return;
  await dbDelete('records', rec.uuid);
  if (editingUuid === rec.uuid) clearForm();
  toast('削除しました');
  await refreshCount();
  await renderList();
}

/* ============================ 一覧 ============================ */

async function renderList() {
  const listEl = document.getElementById('record-list');
  const emptyEl = document.getElementById('list-empty');
  const fId   = document.getElementById('filter-id').value.trim().toLowerCase();
  const fDiag = document.getElementById('filter-diagnosis').value.trim().toLowerCase();
  const fSurg = document.getElementById('filter-surgeon').value.trim().toLowerCase();
  const sortKey = document.getElementById('list-sort').value;

  let records = await dbGetAll('records');

  // 項目別の絞り込み（ID・疾患名・執刀医のAND）
  records = records.filter((r) =>
    (!fId   || (r.patientID || '').toLowerCase().includes(fId)) &&
    (!fDiag || (r.diagnosis || '').toLowerCase().includes(fDiag)) &&
    (!fSurg || (r.surgeon || '').toLowerCase().includes(fSurg)));

  // カウント番号・総数は「絞り込み後の集合」で算出（手術日昇順での順位）
  const countMap = new Map([...records].sort((a, b) =>
    (a.surgeryDate || '').localeCompare(b.surgeryDate || '') ||
    (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map((r, i) => [r.uuid, i + 1]));
  const total = records.length;

  // 表示順（登録No. / 手術日 の昇順・降順）
  const [key, dir] = sortKey.split('-');
  const sign = dir === 'asc' ? 1 : -1;
  records.sort((a, b) => {
    if (key === 'recordNo') return sign * ((a.recordNo || 0) - (b.recordNo || 0));
    return sign * ((a.surgeryDate || '').localeCompare(b.surgeryDate || '') ||
                   (a.createdAt || '').localeCompare(b.createdAt || ''));
  });

  listEl.innerHTML = '';
  emptyEl.hidden = records.length > 0;
  emptyEl.textContent = (fId || fDiag || fSurg) ? '該当する記録がありません' : '記録はまだありません';

  for (const rec of records) {
    const li = document.createElement('li');
    li.className = 'record-item';
    if (selectMode && selectedUuids.has(rec.uuid)) li.classList.add('selected');

    if (selectMode) {
      const chk = document.createElement('div');
      chk.className = 'record-check';
      chk.innerHTML = selectedUuids.has(rec.uuid) ? '&#x2713;' : '';
      li.appendChild(chk);
    }

    const main = document.createElement('div');
    main.className = 'record-main';
    const nos = document.createElement('div');
    nos.className = 'record-nos';
    nos.textContent = `登録No.${rec.recordNo ?? '－'}　/　カウント ${countMap.get(rec.uuid)} / ${total}`;
    main.appendChild(nos);
    const line1 = document.createElement('div');
    line1.className = 'record-line1';
    line1.textContent = `${rec.surgeryDate || '日付なし'}　ID: ${rec.patientID || '－'}`;
    const line2 = document.createElement('div');
    line2.className = 'record-line2';
    line2.textContent = [rec.diagnosis, rec.side, rec.surgeon].filter(Boolean).join(' / ') || '（詳細未入力）';
    main.appendChild(line1);
    main.appendChild(line2);
    if (selectMode) {
      li.addEventListener('click', () => {
        if (selectedUuids.has(rec.uuid)) selectedUuids.delete(rec.uuid);
        else selectedUuids.add(rec.uuid);
        updateSelectBar();
        renderList();
      });
    } else {
      main.addEventListener('click', () => editRecord(rec));
    }

    li.appendChild(main);

    if (!selectMode) {
      const actions = document.createElement('div');
      actions.className = 'record-actions';
      const dup = document.createElement('button');
      dup.className = 'btn-dup';
      dup.textContent = '複製';
      dup.addEventListener('click', (e) => { e.stopPropagation(); enterDuplicateMode(rec); });
      const del = document.createElement('button');
      del.className = 'btn-delete';
      del.textContent = '削除';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteRecord(rec); });
      actions.appendChild(dup);
      actions.appendChild(del);
      li.appendChild(actions);
    }

    listEl.appendChild(li);
  }
}

async function refreshCount() {
  const records = await dbGetAll('records');
  const proms = await dbGetAll('proms');
  document.getElementById('record-count').textContent = `記録 ${records.length} 件 / PROMs ${proms.length} 件`;
  const unsynced = records.filter((r) => !r.syncedAt).length + proms.filter((r) => !r.syncedAt).length;
  const badge = document.getElementById('tab-badge');
  badge.hidden = unsynced === 0;
  badge.textContent = unsynced;
  document.getElementById('unsynced-count').textContent = unsynced;
}

/* ============================ PROMs（術後アウトカム縦断登録） ============================ */
/* 算出済みスコアのみを手入力で登録する。生回答の入力・自動計算はしない（別系統が担当）。
   1患者×左右×時点ごとに1レコード。患者IDで手術記録(records)と紐付ける。 */

/* スコア欄の定義: id=入力要素のサフィックス, field=レコードのフィールド名, min/max=妥当範囲。
   JHEQのレンジは公式参照台帳に基づく（痛み/動作/メンタル各0-28、総点0-84）。
   vas:true の項目は vasScale 設定(100/10)で上限が変わる。 */
const PROMS_SCORE_FIELDS = [
  { id: 'jheqPain',        field: 'jheqPain',        label: 'JHEQ 痛み',    min: 0, max: 28 },
  { id: 'jheqMovement',    field: 'jheqMovement',    label: 'JHEQ 動作',    min: 0, max: 28 },
  { id: 'jheqMental',      field: 'jheqMental',      label: 'JHEQ メンタル', min: 0, max: 28 },
  { id: 'jheqTotal',       field: 'jheqTotal',       label: 'JHEQ 合計',    min: 0, max: 84 },
  { id: 'hoosJr',          field: 'hoosJr',          label: 'HOOS-JR',      min: 0, max: 100 },
  { id: 'fjs12',           field: 'fjs12',           label: 'FJS-12',       min: 0, max: 100 },
  { id: 'vasPain',         field: 'vasPain',         label: 'VAS 痛み',     min: 0, max: 100, vas: true },
  { id: 'vasSatisfaction', field: 'vasSatisfaction', label: 'VAS 満足度',   min: 0, max: 100, vas: true },
];

/* PROMsで使う選択式（records側のチップとは独立した素のselect） */
const PROMS_CHOICE_FIELDS = [
  { id: 'p-side',      catKey: 'side',      field: 'side' },
  { id: 'p-timepoint', catKey: 'timepoint', field: 'timepoint' },
];

let vasScale = 100; // VAS上限（100mm 既定 / 10 へ切替可）。init/設定で meta から読み込む

/* スコアの妥当範囲チェック。vas項目は vasScale を上限に使う。範囲外なら不正な項目ラベルを返す。 */
function promsRangeErrors(rec) {
  const errs = [];
  for (const s of PROMS_SCORE_FIELDS) {
    const v = rec[s.field];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    const max = s.vas ? vasScale : s.max;
    if (isNaN(n) || n < s.min || n > max) errs.push(`${s.label}(${s.min}–${max})`);
  }
  return errs;
}

/* side・timepoint のselectをマスタから再構築（現在の選択値は維持） */
function renderPromsControls() {
  for (const c of PROMS_CHOICE_FIELDS) {
    const sel = document.getElementById(c.id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '未選択';
    sel.appendChild(empty);
    for (const v of activeValues(c.catKey)) {
      const op = document.createElement('option');
      op.value = v;
      op.textContent = v;
      sel.appendChild(op);
    }
    setSelectValue(sel, current);
  }
  // 一覧の時点フィルタ（先頭は「すべての時点」）も再構築
  const tpFilter = document.getElementById('proms-filter-timepoint');
  if (tpFilter) {
    const cur = tpFilter.value;
    tpFilter.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'すべての時点';
    tpFilter.appendChild(all);
    for (const v of activeValues('timepoint')) {
      const op = document.createElement('option');
      op.value = v; op.textContent = v;
      tpFilter.appendChild(op);
    }
    if ([...tpFilter.options].some((o) => o.value === cur)) tpFilter.value = cur;
  }
  applyVasScaleToInputs();
}

async function loadVasScale() {
  vasScale = Number(await getMeta('vasScale', 100)) || 100;
}

async function setVasScale(scale) {
  vasScale = Number(scale) || 100;
  await setMeta('vasScale', vasScale);
  applyVasScaleToInputs();
}

/* VAS入力欄の max/placeholder を現在の vasScale に合わせる */
function applyVasScaleToInputs() {
  for (const s of PROMS_SCORE_FIELDS) {
    if (!s.vas) continue;
    const el = document.getElementById(`p-${s.id}`);
    if (el) { el.max = vasScale; el.placeholder = `0–${vasScale}`; }
  }
}

function collectPromsForm() {
  const rec = {
    patientID:      document.getElementById('p-patientId').value.trim(),
    assessmentDate: document.getElementById('p-date').value,
    notes:          document.getElementById('p-notes').value,
  };
  for (const c of PROMS_CHOICE_FIELDS) {
    rec[c.field] = document.getElementById(c.id).value;
  }
  for (const s of PROMS_SCORE_FIELDS) {
    rec[s.field] = numOrNull(document.getElementById(`p-${s.id}`).value);
  }
  return rec;
}

function fillPromsForm(rec) {
  document.getElementById('p-patientId').value = rec.patientID || '';
  document.getElementById('p-date').value      = rec.assessmentDate || '';
  document.getElementById('p-notes').value     = rec.notes || '';
  for (const c of PROMS_CHOICE_FIELDS) {
    setSelectValue(document.getElementById(c.id), rec[c.field] || '');
  }
  for (const s of PROMS_SCORE_FIELDS) {
    document.getElementById(`p-${s.id}`).value = rec[s.field] ?? '';
  }
  renderPromsControls();
}

function clearPromsForm() {
  editingPromsUuid = null;
  editingPromsMeta = null;
  fillPromsForm({ assessmentDate: todayStr() });
  document.getElementById('proms-mode-label').textContent = '新規PROMs';
  document.getElementById('btn-proms-new').hidden = true;
}

async function savePROMs() {
  const rec = collectPromsForm();
  if (!rec.patientID)  { toast('患者IDを入力してください'); return; }
  if (!rec.timepoint)  { toast('時点を選択してください'); return; }
  const errs = promsRangeErrors(rec);
  if (errs.length) { toast(`範囲外の値: ${errs.join(' / ')}`); return; }

  // 新規保存時、同じ患者ID×時点が既にある場合は重複登録を確認（患者×時点で1件モデル）
  if (!editingPromsUuid) {
    const all = await dbGetAll('proms');
    if (all.some((r) => promsKey(r) === promsKey(rec))) {
      if (!confirm('同じ患者・時点の記録が既にあります。新規に追加しますか？\n（既存の記録を編集して上書きするのが推奨です）')) return;
    }
  }

  const now = new Date().toISOString();
  if (editingPromsUuid) {
    rec.uuid = editingPromsUuid;
    rec.createdAt = editingPromsMeta.createdAt;
    rec.createdDevice = editingPromsMeta.createdDevice;
    rec.syncedAt = null; // 編集したら未送信に戻す（修正をMacへ再伝播させるため）
  } else {
    rec.uuid = genUUID();
    rec.createdAt = now;
    rec.createdDevice = deviceName();
    rec.syncedAt = null;
  }
  rec.updatedAt = now;

  await dbPut('proms', rec);
  toast(editingPromsUuid ? 'PROMsを更新しました' : 'PROMsを保存しました');
  clearPromsForm();
  await refreshCount();
  await renderPromsList();
}

async function editPROMs(rec) {
  editingPromsUuid = rec.uuid;
  editingPromsMeta = { createdAt: rec.createdAt, createdDevice: rec.createdDevice, syncedAt: rec.syncedAt };
  fillPromsForm(rec);
  document.getElementById('proms-mode-label').textContent =
    `編集中: ID ${rec.patientID || '－'} / ${rec.side || '－'} / ${rec.timepoint || '－'}`;
  document.getElementById('btn-proms-new').hidden = false;
  window.scrollTo({ top: 0 });
}

async function deletePROMs(rec) {
  const label = `ID ${rec.patientID || '－'} / ${rec.side || ''} / ${rec.timepoint || ''} / ${rec.assessmentDate || ''}`;
  if (!confirm(`このPROMs記録を削除しますか？\n${label}`)) return;
  await dbDelete('proms', rec.uuid);
  if (editingPromsUuid === rec.uuid) clearPromsForm();
  toast('削除しました');
  await refreshCount();
  await renderPromsList();
}

/* PROMsの自然キー。アンケートは患者×時点で1つ（左右は問わない＝両側でも同じスコア）。
   そのため side はキーに含めず、患者ID×時点でスロットを判定する。外部システム取込でも同じ。 */
function promsKey(r) {
  return `${r.patientID || ''}|${r.timepoint || ''}`;
}

/* 項目単位マージ: target に incoming の「値がある」スコア欄と日付/メモのみ反映し、空欄は既存を温存する。
   target の uuid・createdAt 等は保持。純関数（Nodeテスト用にDOM/DB非依存）。 */
function mergePromsField(target, incoming) {
  const merged = { ...target };
  for (const s of PROMS_SCORE_FIELDS) {
    const v = incoming[s.field];
    if (v !== null && v !== undefined && v !== '') merged[s.field] = v;
  }
  if (incoming.assessmentDate) merged.assessmentDate = incoming.assessmentDate;
  if (incoming.notes)          merged.notes = incoming.notes;
  return merged;
}

/* 時点(timepoint)をマスタのsortOrder順で比較するための索引 */
function timepointOrder() {
  const order = new Map();
  (masters['timepoint'] || []).forEach((o, i) => order.set(o.value, i));
  return order;
}

async function renderPromsList() {
  const listEl = document.getElementById('proms-list');
  const emptyEl = document.getElementById('proms-empty');
  if (!listEl) return;
  const fId = document.getElementById('proms-filter-id').value.trim().toLowerCase();
  const fTp = document.getElementById('proms-filter-timepoint').value;
  const sortKey = document.getElementById('proms-sort').value;

  let rows = await dbGetAll('proms');
  rows = rows.filter((r) =>
    (!fId || (r.patientID || '').toLowerCase().includes(fId)) &&
    (!fTp || r.timepoint === fTp));

  const tpOrder = timepointOrder();
  const byPatient = (a, b) =>
    (a.patientID || '').localeCompare(b.patientID || '', 'ja', { numeric: true }) ||
    ((tpOrder.get(a.timepoint) ?? 99) - (tpOrder.get(b.timepoint) ?? 99)) ||
    (a.assessmentDate || '').localeCompare(b.assessmentDate || '');
  const byDate = (a, b) =>
    (a.assessmentDate || '').localeCompare(b.assessmentDate || '') ||
    (a.patientID || '').localeCompare(b.patientID || '', 'ja', { numeric: true });

  if (sortKey === 'patient') rows.sort(byPatient);
  else if (sortKey === 'date-desc') rows.sort((a, b) => -byDate(a, b));
  else rows.sort(byDate); // date-asc

  listEl.innerHTML = '';
  emptyEl.hidden = rows.length > 0;
  const isFiltered = !!(fId || fTp);
  document.getElementById('proms-empty-text').textContent =
    isFiltered ? '該当するPROMsがありません' : 'まだPROMsはありません';
  // 取り込みボタンは「本当にデータが無い時」だけ出す（絞り込み0件では出さない）
  document.getElementById('btn-proms-import-empty').hidden = isFiltered;

  for (const rec of rows) {
    const li = document.createElement('li');
    li.className = 'record-item';

    const main = document.createElement('div');
    main.className = 'record-main';
    const line1 = document.createElement('div');
    line1.className = 'record-line1';
    line1.textContent = `ID: ${rec.patientID || '－'}　${[rec.side, rec.timepoint].filter(Boolean).join(' / ') || ''}`;
    const line2 = document.createElement('div');
    line2.className = 'record-line2';
    const parts = [];
    if (rec.assessmentDate) parts.push(rec.assessmentDate);
    const scoreBits = PROMS_SCORE_FIELDS
      .filter((s) => rec[s.field] !== null && rec[s.field] !== undefined && rec[s.field] !== '')
      .map((s) => `${s.label.replace('JHEQ ', 'J:').replace('VAS ', 'V:')}${rec[s.field]}`);
    line2.textContent = [parts.join(' '), scoreBits.join(' / ')].filter(Boolean).join('　') || '（スコア未入力）';
    main.appendChild(line1);
    main.appendChild(line2);
    main.addEventListener('click', () => editPROMs(rec));
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'record-actions';
    const del = document.createElement('button');
    del.className = 'btn-delete';
    del.textContent = '削除';
    del.addEventListener('click', (e) => { e.stopPropagation(); deletePROMs(rec); });
    actions.appendChild(del);
    li.appendChild(actions);

    listEl.appendChild(li);
  }

  renderPromsTimeseries();
}

/* 時系列表（表示専用）: IDで絞り込んだ時だけ、患者ID×左右ごとに
   JHEQ合計 / HOOS-JR / FJS-12 の推移を「行=スコア・列=時点」の表で見せる。 */
const TIMESERIES_ROWS = [
  { field: 'jheqTotal', label: 'JHEQ 合計' },
  { field: 'hoosJr',    label: 'HOOS-JR' },
  { field: 'fjs12',     label: 'FJS-12' },
];

function renderPromsTimeseries() {
  const box = document.getElementById('proms-timeseries');
  if (!box) return;
  const fId = document.getElementById('proms-filter-id').value.trim();
  box.innerHTML = '';
  if (!fId) {
    box.innerHTML = '<p class="data-hint">患者IDで絞り込むと、JHEQ/HOOS-JR/FJS-12 合計の推移表を表示します。</p>';
    return;
  }

  dbGetAll('proms').then((all) => {
    const rows = all.filter((r) => (r.patientID || '').toLowerCase().includes(fId.toLowerCase()));
    if (!rows.length) return;

    const timepoints = activeValues('timepoint'); // sortOrder順
    // 患者IDでグルーピング（アンケートは患者×時点で1つ。左右は区別しない）
    const groups = new Map();
    for (const r of rows) {
      const gk = r.patientID;
      if (!groups.has(gk)) groups.set(gk, { patientID: r.patientID, byTp: new Map() });
      const g = groups.get(gk);
      const prev = g.byTp.get(r.timepoint);
      // 同スロット複数なら updatedAt 最新を採用
      if (!prev || (r.updatedAt || '') > (prev.updatedAt || '')) g.byTp.set(r.timepoint, r);
    }
    // 患者ID で安定ソート
    const sortedGroups = [...groups.values()].sort((a, b) =>
      a.patientID.localeCompare(b.patientID, 'ja', { numeric: true }));

    box.innerHTML = '';
    for (const g of sortedGroups) {
      // この患者で実際に値がある時点のみ列に出す（無ければ全標準時点）
      const usedTps = timepoints.filter((tp) => g.byTp.has(tp));
      const cols = usedTps.length ? usedTps : timepoints;

      const wrap = document.createElement('div');
      wrap.className = 'ts-wrap';
      const cap = document.createElement('div');
      cap.className = 'ts-caption';
      cap.textContent = `ID ${g.patientID}`;
      wrap.appendChild(cap);

      const scroll = document.createElement('div');
      scroll.className = 'ts-scroll';
      const table = document.createElement('table');
      table.className = 'ts-table';

      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      const corner = document.createElement('th');
      corner.textContent = 'スコア＼時点';
      htr.appendChild(corner);
      for (const tp of cols) {
        const th = document.createElement('th');
        th.textContent = tp;
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const row of TIMESERIES_ROWS) {
        const tr = document.createElement('tr');
        const rh = document.createElement('th');
        rh.scope = 'row';
        rh.textContent = row.label;
        tr.appendChild(rh);
        for (const tp of cols) {
          const td = document.createElement('td');
          const rec = g.byTp.get(tp);
          const v = rec ? rec[row.field] : null;
          td.textContent = (v === null || v === undefined || v === '') ? '－' : v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      wrap.appendChild(scroll);
      box.appendChild(wrap);
    }
  });
}

/* ============================ 設定（マスタ管理） ============================ */

async function renderSettings() {
  const container = document.getElementById('settings-list');
  container.innerHTML = '';

  for (const c of ALL_CATEGORIES) {
    const options = masters[c.key];
    const details = document.createElement('details');
    details.className = 'settings-group';
    details.dataset.cat = c.key;

    const summary = document.createElement('summary');
    summary.textContent = `${c.label}（${options.length}）`;
    details.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'option-list';
    options.forEach((opt, idx) => {
      const li = document.createElement('li');

      const span = document.createElement('span');
      span.className = 'option-value';
      span.textContent = opt.value;
      li.appendChild(span);

      const up = document.createElement('button');
      up.textContent = '↑';
      up.disabled = idx === 0;
      up.addEventListener('click', () => moveOption(c.key, idx, -1));
      const down = document.createElement('button');
      down.textContent = '↓';
      down.disabled = idx === options.length - 1;
      down.addEventListener('click', () => moveOption(c.key, idx, +1));
      const del = document.createElement('button');
      del.className = 'btn-delete';
      del.textContent = '削除';
      del.addEventListener('click', () => deleteOption(c.key, opt));

      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(del);
      ul.appendChild(li);
    });
    details.appendChild(ul);

    const addRow = document.createElement('div');
    addRow.className = 'add-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `${c.label}を追加`;
    const addBtn = document.createElement('button');
    addBtn.textContent = '追加';
    addBtn.className = 'btn-primary btn-small';
    const doAdd = () => addOption(c.key, input.value);
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    details.appendChild(addRow);

    container.appendChild(details);
  }
}

/* 設定画面の再描画時に開いていたグループを維持する */
function openStates() {
  const states = {};
  for (const d of document.querySelectorAll('.settings-group')) {
    states[d.dataset.cat] = d.open;
  }
  return states;
}

async function refreshSettingsKeepOpen() {
  const states = openStates();
  await loadMasters();
  await renderSettings();
  for (const d of document.querySelectorAll('.settings-group')) {
    if (states[d.dataset.cat]) d.open = true;
  }
  renderFormControls();
  renderPromsControls();
}

async function addOption(catKey, rawValue) {
  const value = rawValue.trim();
  if (!value) return;
  if (masters[catKey].some((o) => o.value === value)) {
    toast('同じ選択肢がすでにあります');
    return;
  }
  const maxOrder = masters[catKey].reduce((m, o) => Math.max(m, o.sortOrder), -1);
  await dbPut('masterOptions', { category: catKey, value, sortOrder: maxOrder + 1, isActive: true });
  toast(`「${value}」を追加しました`);
  await refreshSettingsKeepOpen();
}

async function deleteOption(catKey, opt) {
  if (!confirm(`「${opt.value}」を選択肢から削除しますか？\n（過去の記録の値は変わりません）`)) return;
  await dbDelete('masterOptions', opt.id);
  await refreshSettingsKeepOpen();
}

async function resetAllData() {
  const records = await dbGetAll('records');
  const proms = await dbGetAll('proms');
  if (!confirm(`全 ${records.length} 件の記録と PROMs ${proms.length} 件、すべての選択肢マスタを削除して初期状態に戻します。よろしいですか？`)) return;
  if (!confirm('本当に削除しますか？この操作は取り消せません。')) return;
  await dbRequest('records', 'readwrite', (st) => st.clear());
  await dbRequest('proms', 'readwrite', (st) => st.clear());
  await dbRequest('masterOptions', 'readwrite', (st) => st.clear());
  await dbRequest('meta', 'readwrite', (st) => st.clear()); // 登録番号カウンタも1へ戻す
  await seedDefaultsIfEmpty();
  await loadMasters();
  renderFormControls();
  renderPromsControls();
  clearForm();
  clearPromsForm();
  await renderSettings();
  await refreshCount();
  await renderList();
  await renderPromsList();
  toast('初期化しました');
}

async function moveOption(catKey, idx, dir) {
  const list = masters[catKey];
  const a = list[idx];
  const b = list[idx + dir];
  if (!b) return;
  [a.sortOrder, b.sortOrder] = [b.sortOrder, a.sortOrder];
  await dbPut('masterOptions', a);
  await dbPut('masterOptions', b);
  await refreshSettingsKeepOpen();
}

/* ============================ データ入出力 (Phase 2) ============================ */

/* Excel書き出し列（順序固定）。見出しはインポート時のエイリアスと往復可能にしてある */
const EXPORT_COLUMNS = [
  ['登録番号', 'recordNo'], ['カウント', '__count'],
  ['ID', 'patientID'], ['手術日', (r) => (r.surgeryDate || '').replace(/-/g, '')], ['年齢', 'age'],
  ['性別', 'sex'],
  ['身長(cm)', 'heightCm'], ['体重(kg)', 'weightKg'], ['BMI', '__bmi'],
  ['左右', 'side'], ['疾患名', 'diagnosis'], ['Crowe分類', 'croweGroup'],
  ['執刀医', 'surgeon'], ['アプローチ', 'approach'],
  ['手術時間(分)', 'operationTimeMin'], ['出血量(ml)', 'bloodLossML'],
  // Cup/Stem/Headはアプリ上は分割入力だが、Excelでは1セルに結合して書き出す
  ['cup', (r) => [r.cupName, r.cupSize].filter(Boolean).join(' ')],
  ['liner種類', 'linerType'],
  ['head', (r) => [r.headSize, r.headMaterial].filter(Boolean).join(' ')],
  ['stem', (r) => [r.stemName, r.stemSize].filter(Boolean).join(' ')],
  ['navigation名', 'navigationName'], ['navigation RI', 'navRI'], ['navigation RA', 'navRA'],
  ['実測RI', 'measuredRI'], ['実測RA', 'measuredRA'],
  ['メモ', 'memo'], ['手術記録', 'operativeNote'],
];

/* インポート時の列名エイリアス（正規化後の表記で列挙） */
const IMPORT_ALIASES = {
  surgeryDate:      ['手術日', '日付', '手術日付', 'date'],
  patientID:        ['id', '患者id', '患者番号', '症例id'],
  age:              ['年齢', 'age'],
  heightCm:         ['身長', '身長(cm)', '身長cm', 'height'],
  weightKg:         ['体重', '体重(kg)', '体重kg', 'weight'],
  sex:              ['性別', 'sex'],
  side:             ['左右', '患側', 'side'],
  diagnosis:        ['疾患名', '疾患', '診断名', '診断', 'diagnosis'],
  croweGroup:       ['crowe分類', 'crowe', 'crowe群'],
  surgeon:          ['執刀医', '執刀', '術者', 'surgeon'],
  approach:         ['アプローチ', '進入法', 'approach'],
  operationTimeMin: ['手術時間', '手術時間(分)', '手術時間分', 'optime', 'time'],
  bloodLossML:      ['出血量', '出血量(ml)', '出血量ml', 'ebl', 'bloodloss'],
  cupName:          ['cup名', 'cup', 'カップ', 'カップ名', 'cup商品名'],
  cupSize:          ['cupサイズ', 'cupsize', 'カップサイズ', 'cup径'],
  linerType:        ['liner種類', 'liner', 'liner名', 'ライナー', 'hxlpe'],
  stemName:         ['stem名', 'stem', 'ステム', 'ステム名', 'taperloc6ho', 'stem商品名'],
  stemSize:         ['stemサイズ', 'stemsize', 'ステムサイズ'],
  headSize:         ['headサイズ', 'headsize', 'ヘッドサイズ', '骨頭サイズ', '骨頭径', 'head', 'ヘッド', '骨頭', '32-6delta'],
  headMaterial:     ['head素材', 'headmaterial', 'ヘッド素材', '骨頭素材'],
  navigationName:   ['navigation名', 'navigation', 'ナビゲーション', 'ナビ', 'nav', 'arhippinless'],
  navRI:            ['navigationri', 'navri', 'ナビri'],
  navRA:            ['navigationra', 'navra', 'ナビra'],
  measuredRI:       ['実測ri'],
  measuredRA:       ['実測ra'],
  memo:             ['メモ', 'フリー記述', '備考', 'コメント'],
  operativeNote:    ['手術記録', '手術所見', 'オペ記録'],
};

const NUMERIC_FIELDS = ['age', 'operationTimeMin', 'bloodLossML'];
const FLOAT_FIELDS = ['heightCm', 'weightKg'];

/* BMIは保存せず身長・体重から都度計算する */
function bmiOf(heightCm, weightKg) {
  const h = Number(heightCm), w = Number(weightKg);
  if (!(h > 0) || !(w > 0)) return null;
  return Math.round((w / ((h / 100) ** 2)) * 10) / 10;
}

/* 取り込み時に認識するが記録には保存しない列（BMIは再計算するため） */
const IGNORED_HEADERS = ['bmi', '登録番号', 'カウント'];

function normalizeHeader(s) {
  return String(s).toLowerCase().replace(/[\s　]/g, '').replace(/（/g, '(').replace(/）/g, ')');
}

/* 列名 → フィールド名の対応表を作る */
function buildHeaderMap(firstRow) {
  const map = {};
  for (const key of Object.keys(firstRow)) {
    const n = normalizeHeader(key);
    for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
      if (aliases.includes(n)) { map[key] = field; break; }
    }
  }
  return map;
}

/* Excelシリアル値・yyyymmdd数値・Dateオブジェクト・各種文字列を yyyy-mm-dd に正規化 */
function normalizeDateValue(v) {
  const pad = (x) => String(x).padStart(2, '0');
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === 'number') {
    const n = Math.round(v);
    // 20260422 のような yyyymmdd 形式の数値
    if (n >= 19000101 && n <= 99991231) {
      const y = Math.floor(n / 10000), mo = Math.floor(n / 100) % 100, d = n % 100;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
      return '';
    }
    // Excelシリアル値（UTC基準で変換し日ズレを防ぐ。上限は9999-12-31相当）
    if (n > 59 && n < 2958466) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    return '';
  }
  const s = String(v).trim();
  // 文字列の yyyymmdd（例: "20260422"）
  if (/^(19|20)\d{6}$/.test(s)) {
    const mo = Number(s.slice(4, 6)), d = Number(s.slice(6, 8));
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${s.slice(0, 4)}-${pad(mo)}-${pad(d)}`;
    return '';
  }
  const m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return '';
}

/* 性別・左右の略記を正規化（各種表記 → マスタの正規値）*/
const VALUE_MAP = {
  sex: {
    'm': 'M', 'male': 'M', '男': 'M', '男性': 'M',
    'f': 'F', 'female': 'F', '女': 'F', '女性': 'F',
  },
  side: {
    'rt': 'Rt', 'r': 'Rt', 'right': 'Rt', '右': 'Rt', '右側': 'Rt',
    'lt': 'Lt', 'l': 'Lt', 'left': 'Lt', '左': 'Lt', '左側': 'Lt',
    'bil': '両側', 'bilateral': '両側', '両': '両側', 'b': '両側',
  },
};

function normalizeChoiceValue(field, value) {
  const map = VALUE_MAP[field];
  if (!map) return value;
  return map[value.toLowerCase()] || value;
}

/* Excel/CSV用の重複判定キー */
function dupKey(r) {
  return `${r.surgeryDate}|${r.patientID}|${r.side}`;
}

/* レコードが持つ全フィールド（emptyRecordの初期化用）。
   Excelでは一部を結合列にするためEXPORT_COLUMNSとは1対1にならないので別途定義する。 */
const RECORD_FIELDS = [
  'surgeryDate', 'patientID', 'age', 'heightCm', 'weightKg',
  'sex', 'side', 'diagnosis', 'croweGroup', 'surgeon', 'approach',
  'operationTimeMin', 'bloodLossML',
  'cupName', 'cupSize', 'linerType', 'stemName', 'stemSize', 'headSize', 'headMaterial',
  'navigationName', 'navRI', 'navRA', 'measuredRI', 'measuredRA',
  'memo', 'operativeNote',
];

function emptyRecord() {
  const rec = {};
  for (const field of RECORD_FIELDS) {
    rec[field] = (NUMERIC_FIELDS.includes(field) || FLOAT_FIELDS.includes(field)) ? null : '';
  }
  return rec;
}

function sheetRowToRecord(row, headerMap) {
  const rec = emptyRecord();
  for (const [col, field] of Object.entries(headerMap)) {
    const v = row[col];
    if (v === undefined || v === null || v === '') continue;
    if (field === 'surgeryDate') {
      rec.surgeryDate = normalizeDateValue(v);
    } else if (NUMERIC_FIELDS.includes(field)) {
      const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
      rec[field] = isNaN(n) ? null : Math.round(n);
    } else if (FLOAT_FIELDS.includes(field)) {
      const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
      rec[field] = isNaN(n) ? null : Math.round(n * 10) / 10;
    } else {
      rec[field] = normalizeChoiceValue(field, String(v).trim());
    }
  }
  return rec;
}

/* 取り込んだ記録に出てくる未登録の選択肢を洗い出す */
function collectNewMasterValues(records) {
  const found = [];
  for (const c of CATEGORIES) {
    const known = new Set(masters[c.key].map((o) => o.value));
    for (const r of records) {
      const v = r[c.field];
      if (v && !known.has(v)) {
        known.add(v);
        found.push({ category: c.key, value: v });
      }
    }
  }
  return found;
}

async function addMasterValues(list) {
  if (!list.length) return;
  for (const { category, value } of list) {
    const maxOrder = masters[category].reduce((m, o) => Math.max(m, o.sortOrder), -1);
    await dbPut('masterOptions', { category, value, sortOrder: maxOrder + 1, isActive: true });
    masters[category].push({ category, value, sortOrder: maxOrder + 1, isActive: true });
  }
  await loadMasters();
  renderFormControls();
  await renderSettings();
}

async function refreshAfterDataChange() {
  await refreshCount();
  await renderList();
  await renderPromsList();
}

/* ---------- エクスポート ---------- */

function timestamp() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function buildExportData(onlyUnsynced) {
  const records = await dbGetAll('records');
  const proms = await dbGetAll('proms');
  const masterOptions = await dbGetAll('masterOptions');
  return {
    app: 'ope-note',
    format: 1,
    exportedAt: new Date().toISOString(),
    device: deviceName(),
    records: onlyUnsynced ? records.filter((r) => !r.syncedAt) : records,
    proms: onlyUnsynced ? proms.filter((r) => !r.syncedAt) : proms,
    masterOptions: masterOptions.map(({ category, value, sortOrder, isActive }) =>
      ({ category, value, sortOrder, isActive })),
  };
}

async function markSynced(records) {
  const now = new Date().toISOString();
  for (const r of records) {
    r.syncedAt = now;
    await dbPut('records', r);
  }
  await refreshCount();
}

async function markSyncedProms(proms) {
  const now = new Date().toISOString();
  for (const r of proms) {
    r.syncedAt = now;
    await dbPut('proms', r);
  }
  await refreshCount();
}

async function exportJSON(onlyUnsynced) {
  const data = await buildExportData(onlyUnsynced);
  if (onlyUnsynced && data.records.length === 0 && data.proms.length === 0) {
    toast('未送信のデータはありません');
    return;
  }
  const summary = `記録 ${data.records.length} 件・PROMs ${data.proms.length} 件`;
  const name = onlyUnsynced ? `openote_未送信_${timestamp()}.json` : `openote_全件_${timestamp()}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '手術記録データ' });
      if (onlyUnsynced) { await markSynced(data.records); await markSyncedProms(data.proms); }
      toast(`${summary} を書き出しました`);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // キャンセル時は送信済みにしない
      // 共有が使えない環境ではダウンロードにフォールバック
    }
  }
  downloadFile(file);
  if (onlyUnsynced && confirm(`${summary} を書き出しました。「送信済み」にしますか？`)) {
    await markSynced(data.records);
    await markSyncedProms(data.proms);
  }
}

/* ---------- 選択モード ---------- */

function updateSelectBar() {
  const bar = document.getElementById('select-bar');
  const n = selectedUuids.size;
  bar.hidden = n === 0;
  document.getElementById('select-count').textContent = `${n}件選択中`;
}

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedUuids.clear();
  const btn = document.getElementById('btn-select-mode');
  btn.textContent = selectMode ? '選択解除' : '選択';
  btn.classList.toggle('active', selectMode);
  document.getElementById('select-bar').hidden = true;
  renderList();
}

async function exportSelectedJSON() {
  if (!selectedUuids.size) return;
  const all = await dbGetAll('records');
  const selected = all.filter((r) => selectedUuids.has(r.uuid));
  const masterOptions = await dbGetAll('masterOptions');
  const data = {
    app: 'ope-note',
    format: 1,
    exportedAt: new Date().toISOString(),
    device: deviceName(),
    records: selected,
    masterOptions: masterOptions.map(({ category, value, sortOrder, isActive }) =>
      ({ category, value, sortOrder, isActive })),
  };
  const name = `openote_選択_${timestamp()}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '手術記録データ' });
      if (confirm(`${selected.length} 件を書き出しました。「送信済み」にしますか？`)) {
        await markSynced(selected);
      }
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  downloadFile(file);
  if (confirm(`${selected.length} 件を書き出しました。「送信済み」にしますか？`)) {
    await markSynced(selected);
  }
}

/* 渡された records を手術日昇順でExcel(.xlsx)に書き出す共通処理 */
function writeRecordsToXLSX(records) {
  if (typeof XLSX === 'undefined') { alert('Excelライブラリが読み込まれていません'); return false; }
  if (!records.length) { toast('記録がありません'); return false; }
  records.sort((a, b) => (a.surgeryDate || '').localeCompare(b.surgeryDate || ''));
  const rows = records.map((r, i) => {
    const o = {};
    for (const [header, field] of EXPORT_COLUMNS) {
      if (field === '__count') o[header] = i + 1; // 書き出しは手術日昇順なので i+1 がカウント
      else if (typeof field === 'function') o[header] = field(r);
      else if (field === '__bmi') o[header] = bmiOf(r.heightCm, r.weightKg) ?? '';
      else o[header] = r[field] ?? '';
    }
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS.map((c) => c[0]) });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '手術記録');
  XLSX.writeFile(wb, `手術記録_${timestamp()}.xlsx`);
  return true;
}

async function exportXLSX() {
  const records = await dbGetAll('records');
  if (writeRecordsToXLSX(records)) toast(`${records.length} 件をExcelに書き出しました`);
}

async function exportSelectedXLSX() {
  if (!selectedUuids.size) return;
  const all = await dbGetAll('records');
  const selected = all.filter((r) => selectedUuids.has(r.uuid));
  if (writeRecordsToXLSX(selected)) toast(`${selected.length} 件をExcelに書き出しました`);
}

/* PROMs縦断シートの列定義（行=患者×左右×時点、列=各スコア） */
const PROMS_EXPORT_COLUMNS = [
  ['患者ID', 'patientID'], ['左右', 'side'], ['時点', 'timepoint'],
  ['評価日', (r) => (r.assessmentDate || '').replace(/-/g, '')],
  ['JHEQ痛み', 'jheqPain'], ['JHEQ動作', 'jheqMovement'], ['JHEQメンタル', 'jheqMental'], ['JHEQ合計', 'jheqTotal'],
  ['HOOS-JR', 'hoosJr'], ['FJS-12', 'fjs12'],
  ['VAS痛み', 'vasPain'], ['VAS満足度', 'vasSatisfaction'],
  ['メモ', 'notes'],
];

/* PROMsを患者ID→時点(sortOrder)→評価日 で整列してExcel(.xlsx)に書き出す */
function writePromsToXLSX(proms) {
  if (typeof XLSX === 'undefined') { alert('Excelライブラリが読み込まれていません'); return false; }
  if (!proms.length) { toast('PROMsがありません'); return false; }
  const tpOrder = timepointOrder();
  proms.sort((a, b) =>
    (a.patientID || '').localeCompare(b.patientID || '', 'ja', { numeric: true }) ||
    ((tpOrder.get(a.timepoint) ?? 99) - (tpOrder.get(b.timepoint) ?? 99)) ||
    (a.assessmentDate || '').localeCompare(b.assessmentDate || ''));
  const rows = proms.map((r) => {
    const o = {};
    for (const [header, field] of PROMS_EXPORT_COLUMNS) {
      if (typeof field === 'function') o[header] = field(r);
      else o[header] = r[field] ?? '';
    }
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(rows, { header: PROMS_EXPORT_COLUMNS.map((c) => c[0]) });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PROMs');
  XLSX.writeFile(wb, `PROMs_${timestamp()}.xlsx`);
  return true;
}

async function exportPromsXLSX() {
  const proms = await dbGetAll('proms');
  if (writePromsToXLSX(proms)) toast(`PROMs ${proms.length} 件をExcelに書き出しました`);
}

/* ---------- 暗号化バックアップ（Web Crypto: PBKDF2 + AES-256-GCM） ---------- */
/* iCloud等のクラウドに置く前提のバックアップ。パスワードから鍵を導出し中身を暗号化する。
   復元時は「取り込み」に通常どおりドロップ → パスワード入力で復号 → 既存のUUIDマージへ流す。
   ※高度なデータ保護(E2EE)が未設定でも、ファイル自体が暗号化されているため漏洩時に中身を読めない。 */
const ENC_ITER = 250000;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, salt, iter) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']);
}

async function encryptPayload(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ENC_ITER);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return {
    app: 'ope-note', enc: 'aes-gcm', v: 1, kdf: 'PBKDF2',
    iter: ENC_ITER, hash: 'SHA-256',
    salt: bufToB64(salt), iv: bufToB64(iv), ct: bufToB64(ct),
  };
}

async function decryptPayload(obj, password) {
  const key = await deriveKey(password, b64ToBytes(obj.salt), obj.iter || ENC_ITER);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(obj.iv) }, key, b64ToBytes(obj.ct));
  return new TextDecoder().decode(pt);
}

async function exportEncrypted() {
  const data = await buildExportData(false); // 全件
  if (!data.records.length && !data.proms.length) { toast('記録がありません'); return; }
  const pw = prompt('バックアップを暗号化するパスワードを入力してください。\n※このパスワードは復元時に必要です。忘れると復号できません。');
  if (pw === null) return;
  if (pw.length < 6) { alert('パスワードは6文字以上にしてください'); return; }
  if (prompt('確認のためもう一度入力してください') !== pw) { alert('パスワードが一致しません'); return; }

  const payload = await encryptPayload(JSON.stringify(data), pw);
  const name = `openote_暗号化_${timestamp()}.json`;
  const file = new File([JSON.stringify(payload)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '手術記録（暗号化バックアップ）' });
      toast(`記録 ${data.records.length} 件・PROMs ${data.proms.length} 件を暗号化して書き出しました`);
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadFile(file);
  toast(`記録 ${data.records.length} 件・PROMs ${data.proms.length} 件を暗号化して書き出しました`);
}

/* ---------- インポート ---------- */

async function handleImportFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'json') await importJSONFile(file);
    else if (['csv', 'xlsx', 'xls'].includes(ext)) await importSheetFile(file);
    else alert('対応形式は .json / .csv / .xlsx です');
  } catch (e) {
    console.error(e);
    alert('取り込みに失敗しました。ファイルを確認して、もう一度選択してください。');
  }
}

async function importJSONFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { alert('JSONを読めませんでした。OCR後の ope_note_proms.json を選択してください。'); return; }

  // 暗号化バックアップなら復号してから取り込む
  if (data && data.app === 'ope-note' && data.enc) {
    const pw = prompt('暗号化バックアップのパスワードを入力してください');
    if (pw === null) return;
    try { data = JSON.parse(await decryptPayload(data, pw)); }
    catch { alert('復号に失敗しました。パスワードが違うか、ファイルが壊れています。'); return; }
  }

  if (data.app !== 'ope-note' || !Array.isArray(data.records)) {
    alert('ope-note形式のJSONではありません。書き出した .json（PROMsは ope_note_proms.json）を選択してください。');
    return;
  }

  const existingArr = await dbGetAll('records');
  const existing = new Map(existingArr.map((r) => [r.uuid, r]));

  // 登録番号: 既存と衝突しなければ取り込み元の番号を維持、衝突・未付番なら自分のカウンタで採番
  const usedNos = new Set(existingArr.map((r) => Number(r.recordNo)).filter(Boolean));
  let nextNo = await getMeta('nextRecordNo', 1);
  const maxUsed = usedNos.size ? Math.max(...usedNos) : 0;
  if (nextNo <= maxUsed) nextNo = maxUsed + 1;

  const toPut = [];
  let added = 0, updated = 0, skipped = 0;
  for (const r of data.records) {
    if (!r.uuid) continue;
    const cur = existing.get(r.uuid);
    if (!cur) {
      const n = Number(r.recordNo);
      if (n && !usedNos.has(n)) { r.recordNo = n; usedNos.add(n); if (n >= nextNo) nextNo = n + 1; }
      else { r.recordNo = nextNo++; usedNos.add(r.recordNo); }
      toPut.push(r); added++;
    } else if ((r.updatedAt || '') > (cur.updatedAt || '')) {
      r.recordNo = cur.recordNo; // 既存の登録番号を維持
      toPut.push(r); updated++;
    } else skipped++;
  }

  // PROMs のマージ（3分岐）:
  //  ① uuid 一致 → レコード丸ごと updatedAt 新しい方勝ち（同一レコードの別端末編集を尊重）
  //  ② uuid 不一致だが 患者ID×時点 が一致 → 同じスロットの別ソース。項目単位で埋める（既存uuid保持）
  //  ③ どちらも不一致 → 新規追加
  const existingProms = await dbGetAll('proms');
  const promsByUuid = new Map(existingProms.map((r) => [r.uuid, r]));
  const promsByKey = new Map(existingProms.map((r) => [promsKey(r), r]));
  const promsToPut = [];
  const nowIso = new Date().toISOString();
  let pAdded = 0, pUpdated = 0, pFilled = 0, pSkipped = 0;
  if (Array.isArray(data.proms)) {
    for (const r of data.proms) {
      if (!r.uuid) continue;
      const byUuid = promsByUuid.get(r.uuid);
      if (byUuid) {
        if ((r.updatedAt || '') > (byUuid.updatedAt || '')) { promsToPut.push(r); pUpdated++; }
        else pSkipped++;
        continue;
      }
      const byKey = promsByKey.get(promsKey(r));
      if (byKey) {
        // 既存スロットへ項目単位で反映（既存uuidは保持）。変更があった時だけ書き戻す。
        const merged = mergePromsField(byKey, r);
        if (JSON.stringify(merged) !== JSON.stringify(byKey)) {
          merged.updatedAt = nowIso;
          merged.syncedAt = null; // マージ結果を他端末へ再伝播
          promsToPut.push(merged); pFilled++;
        } else pSkipped++;
      } else {
        promsToPut.push(r); pAdded++;
      }
    }
  }

  const incomingMasters = Array.isArray(data.masterOptions)
    ? data.masterOptions.filter((m) => m.category && m.value && masters[m.category])
        .map((m) => ({ category: m.category, value: m.value }))
    : [];
  const newMasters = [];
  for (const m of incomingMasters) {
    if (!masters[m.category].some((o) => o.value === m.value) &&
        !newMasters.some((x) => x.category === m.category && x.value === m.value)) {
      newMasters.push(m);
    }
  }

  const msg = `${file.name}\n記録: 新規 ${added} / 更新 ${updated} / 変更なし ${skipped}\n` +
    `PROMs: 新規 ${pAdded} / 更新 ${pUpdated} / 項目埋め ${pFilled} / 変更なし ${pSkipped}\n` +
    `選択肢マスタへの追加: ${newMasters.length} 件\n取り込みますか？`;
  if (!confirm(msg)) return;

  for (const r of toPut) await dbPut('records', r);
  for (const r of promsToPut) await dbPut('proms', r);
  await setMeta('nextRecordNo', nextNo);
  await addMasterValues(newMasters);
  await refreshAfterDataChange();
  // 実際に変化した側だけを出す（PROMsだけ取り込んだ時に「記録 新規0」を出さない）
  const recPart = (added || updated) ? `記録 新規${added}・更新${updated}` : '';
  const promsPart = (pAdded || pUpdated || pFilled)
    ? `PROMs 新規${pAdded}・更新${pUpdated}・項目埋め${pFilled}` : '';
  const parts = [recPart, promsPart].filter(Boolean);
  toast(parts.length ? `取り込み完了：${parts.join(' / ')}` : '変更はありませんでした');
}

async function importSheetFile(file) {
  if (typeof XLSX === 'undefined') { alert('Excelライブラリが読み込まれていません'); return; }

  let wb;
  if (/\.csv$/i.test(file.name)) {
    // UTF-8で読めなければShift-JIS（旧Excelの既定）として読む
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { text = new TextDecoder('shift-jis').decode(buf); }
    wb = XLSX.read(text, { type: 'string' });
  } else {
    wb = XLSX.read(await file.arrayBuffer());
  }

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!rows.length) { alert('データ行がありません'); return; }

  const headerMap = buildHeaderMap(rows[0]);
  const mapped = Object.values(headerMap);
  if (!mapped.includes('surgeryDate') && !mapped.includes('patientID')) {
    alert('列名を認識できませんでした。1行目に「手術日」「ID」などの見出し行が必要です。');
    return;
  }
  const unknownCols = Object.keys(rows[0])
    .filter((k) => !headerMap[k] && !IGNORED_HEADERS.includes(normalizeHeader(k)));

  const existing = await dbGetAll('records');
  const seen = new Set(existing.map(dupKey));
  const now = new Date().toISOString();
  const toAdd = [];
  let dup = 0, emptyRows = 0;
  for (const row of rows) {
    const rec = sheetRowToRecord(row, headerMap);
    if (!rec.surgeryDate && !rec.patientID) { emptyRows++; continue; }
    const key = dupKey(rec);
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    rec.uuid = genUUID();
    rec.createdAt = now;
    rec.updatedAt = now;
    rec.createdDevice = deviceName();
    rec.syncedAt = now; // Excel由来＝マスタ側に既存とみなし未送信に積まない
    toAdd.push(rec);
  }

  const newMasters = collectNewMasterValues(toAdd);
  let msg = `${file.name}\n読み込み ${rows.length} 行 → 新規登録 ${toAdd.length} 件 / 重複スキップ ${dup} 件`;
  if (emptyRows) msg += ` / 空行 ${emptyRows} 件`;
  msg += `\n選択肢マスタへの自動追加: ${newMasters.length} 件`;
  if (unknownCols.length) msg += `\n未対応の列（無視されます）: ${unknownCols.join(', ')}`;
  msg += '\n実行しますか？';
  if (!confirm(msg)) return;

  let nextNo = await getMeta('nextRecordNo', 1);
  const maxUsed = existing.reduce((m, r) => Math.max(m, Number(r.recordNo) || 0), 0);
  if (nextNo <= maxUsed) nextNo = maxUsed + 1;
  for (const r of toAdd) r.recordNo = nextNo++;

  for (const r of toAdd) await dbPut('records', r);
  await setMeta('nextRecordNo', nextNo);
  await addMasterValues(newMasters);
  await refreshAfterDataChange();
  toast(`${toAdd.length} 件を取り込みました`);
}

/* ============================ ビュー切替 ============================ */

function switchView(name) {
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === `view-${name}`);
  }
  for (const b of document.querySelectorAll('.tabbar button')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  if (name === 'list') {
    if (selectMode) { selectMode = false; selectedUuids.clear(); const btn = document.getElementById('btn-select-mode'); if (btn) { btn.textContent = '選択'; btn.classList.remove('active'); } document.getElementById('select-bar').hidden = true; }
    renderList();
  }
  if (name === 'proms') renderPromsList();
  if (name === 'data') refreshCount();
}

/* ============================ 初期化 ============================ */

async function init() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist(); // IndexedDB消失リスク低減（結果は待たなくてよい）
  }
  db = await openDB();
  await seedDefaultsIfEmpty();
  await seedCategoryIfEmpty('timepoint'); // 既存ユーザーにも時点の既定選択肢を投入
  await loadMasters();
  await loadVasScale();
  await backfillRecordNos();

  renderFormControls();
  clearForm();
  renderPromsControls();
  clearPromsForm();
  await renderSettings();
  await renderPromsList();
  await refreshCount();

  document.getElementById('btn-save').addEventListener('click', saveRecord);
  document.getElementById('f-height').addEventListener('input', updateBMIDisplay);
  document.getElementById('f-weight').addEventListener('input', updateBMIDisplay);
  document.getElementById('btn-new').addEventListener('click', () => {
    if (confirm('編集を中止して新規入力に切り替えますか？（未保存の変更は破棄されます）')) clearForm();
  });
  // 編集中の内容をそのまま引き継いだ未保存の新規入力にする（両側症例の右→左など）
  document.getElementById('btn-duplicate').addEventListener('click', () => enterDuplicateMode(collectForm()));
  for (const id of ['filter-id', 'filter-diagnosis', 'filter-surgeon']) {
    document.getElementById(id).addEventListener('input', renderList);
  }
  document.getElementById('list-sort').addEventListener('change', renderList);
  for (const b of document.querySelectorAll('.tabbar button')) {
    b.addEventListener('click', () => switchView(b.dataset.view));
  }

  document.getElementById('btn-reset-all').addEventListener('click', resetAllData);

  // データ入出力
  document.getElementById('btn-export-unsynced').addEventListener('click', () => exportJSON(true));
  document.getElementById('btn-export-all-json').addEventListener('click', () => exportJSON(false));
  document.getElementById('btn-select-mode').addEventListener('click', toggleSelectMode);
  document.getElementById('btn-export-selected').addEventListener('click', exportSelectedJSON);
  document.getElementById('btn-export-selected-xlsx').addEventListener('click', exportSelectedXLSX);
  document.getElementById('btn-export-xlsx').addEventListener('click', exportXLSX);
  document.getElementById('btn-export-encrypted').addEventListener('click', exportEncrypted);
  document.getElementById('btn-export-proms-xlsx').addEventListener('click', exportPromsXLSX);

  // PROMsタブ
  document.getElementById('btn-proms-save').addEventListener('click', savePROMs);
  document.getElementById('btn-proms-new').addEventListener('click', () => {
    if (confirm('編集を中止して新規入力に切り替えますか？（未保存の変更は破棄されます）')) clearPromsForm();
  });
  const triggerImport = () => document.getElementById('file-input').click();
  document.getElementById('btn-proms-import').addEventListener('click', triggerImport);
  document.getElementById('btn-proms-import-empty').addEventListener('click', triggerImport);
  document.getElementById('proms-filter-id').addEventListener('input', renderPromsList);
  document.getElementById('proms-filter-timepoint').addEventListener('change', renderPromsList);
  document.getElementById('proms-sort').addEventListener('change', renderPromsList);

  // 設定: VASスケール切替
  const vasSel = document.getElementById('vas-scale');
  if (vasSel) {
    vasSel.value = String(vasScale);
    vasSel.addEventListener('change', () => setVasScale(vasSel.value));
  }

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    if (fileInput.files.length) await handleImportFile(fileInput.files[0]);
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) await handleImportFile(e.dataTransfer.files[0]);
  });
}

init().catch((err) => {
  console.error(err);
  alert('初期化に失敗しました: ' + err.message);
});
