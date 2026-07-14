/**
 * 飲酒カウンター v2 — コアロジック（検証済み）
 * UIから独立した純関数群。GPTはこのファイルを <script> で読み込むか
 * 単一HTMLに埋め込み、UI層からこれらの関数だけを呼べばよい。
 * ロジックの改変は不要（改変しないこと）。
 */

// ================= 定数 =================
const DRINKS = [
  { name: "生中",      emoji: "🍺", ml: 500, abv: 5,  price: 550 },
  { name: "缶ビール",  emoji: "🍺", ml: 350, abv: 5,  price: 250 },
  { name: "ハイボール",emoji: "🥃", ml: 350, abv: 7,  price: 450 },
  { name: "サワー",    emoji: "🍋", ml: 350, abv: 5,  price: 450 },
  { name: "ストロング",emoji: "⚡", ml: 350, abv: 9,  price: 200 },
  { name: "日本酒1合", emoji: "🍶", ml: 180, abv: 15, price: 600 },
  { name: "ワイン",    emoji: "🍷", ml: 125, abv: 12, price: 600 },
  { name: "焼酎ロック",emoji: "🥛", ml: 90,  abv: 25, price: 500 },
  { name: "ショット",  emoji: "🥂", ml: 30,  abv: 40, price: 700 },
];

const BETA = 0.15;              // アルコール分解速度 g/L/時（平均値）
const ABSORB_MIN = 30;          // 1杯の吸収完了までの時間（分）— 曲線を滑らかにする線形ランプ
const R = { m: 0.68, f: 0.55 }; // Widmark係数（体内分布比）

// 翌朝の振り返り: 症状・服薬の選択肢（UIはこれをチップとして表示）
const SYMPTOMS = ["頭痛", "吐き気", "嘔吐", "倦怠感", "めまい", "口渇",
                  "食欲不振", "動悸", "下痢", "集中力低下"];
// 一般名（商品名例）表記。経口補水液は医薬品でないためUI見出しは「服薬・対処」とする
const MEDS = ["ロキソプロフェン（例: ロキソニン）", "レバミピド", "プロトンポンプ阻害薬（PPI）",
              "五苓散", "経口補水液", "制吐薬"];

/**
 * 危険症状時の固定安全表示。ランダム抽選せず、この文言をそのまま出すこと。
 * 発動条件はUI仕様書参照（不調ボタン・認知インデックス50%未満）。
 * 優先順位: ①飲酒中止 ②一人にしない ③誤嚥しにくい姿勢 ④呼吸・反応の確認 ⑤119。
 * 意識が悪い人に無理に水を飲ませない（誤嚥リスク）。帰宅より安全確保を優先。
 */
const SAFETY_NOTICE =
  "これ以上の飲酒は中止してください。一人にならず、周囲の人と一緒にいてください。" +
  "意識がはっきりしていて自力で安全に飲める場合のみ、少量の水を。" +
  "眠り込む・呼びかけへの反応が悪い・呼吸がおかしい・繰り返し吐く場合は、" +
  "無理に飲食させず、横向きの姿勢にして、ためらわず救急要請（119）を。";

// 酔い段階 [BAC%下限, ラベル, 絵文字]
const STAGES = [
  [0.02, "爽快期",     "🙂"],
  [0.05, "ほろ酔い期", "😊"],
  [0.11, "酩酊初期",   "🥴"],
  [0.16, "酩酊期",     "😵"],
  [0.31, "泥酔期",     "🫠"],
  [0.41, "昏睡リスク", "🚨"],
];

// ================= 基本計算 =================
/** 純アルコール量(g) = ml × 度数% ÷ 100 × 0.8 */
const pureAlcoholG = (ml, abv) => Math.round(ml * abv / 100 * 0.8 * 10) / 10;

/**
 * ローカル日付キー YYYY-MM-DD（UTCずれ防止）。
 * 深夜2時未満は前日扱い（飲み会の日付は「その夜」に帰属させる）。
 */
const localKey = d => {
  const adjusted = new Date(d);
  if (adjusted.getHours() < 2) adjusted.setDate(adjusted.getDate() - 1);
  return adjusted.getFullYear() + "-" + String(adjusted.getMonth() + 1).padStart(2, "0") + "-" +
    String(adjusted.getDate()).padStart(2, "0");
};

function stageOf(bac) {
  let s = ["シラフ", "😀"];
  for (const [th, name, emoji] of STAGES) if (bac >= th) s = [name, emoji];
  return { name: s[0], emoji: s[1] };
}

// ================= BAC モデル =================
/**
 * 時刻 tMs における吸収済み純アルコール量(g)。
 * 各ドリンクは摂取時刻から ABSORB_MIN 分かけて線形に吸収されるとみなす。
 * log: [{t:摂取時刻ms, g:純アルコールg, water:bool}]
 */
function absorbedGrams(log, tMs) {
  let a = 0;
  for (const e of log) {
    if (e.water || e.t > tMs) continue;
    const frac = Math.min(1, (tMs - e.t) / (ABSORB_MIN * 60000));
    a += e.g * frac;
  }
  return a;
}

/**
 * 時刻 tMs における推定BAC(%)。ゼロ次消失の逐次シミュレーション。
 * 1分刻みで「吸収による増加 − β×Δt の分解（BAC>0の間のみ）」を積算する。
 * これにより
 *  (a) 時間を空けた追加飲酒がセッション開始からの分解時間で過小評価される問題、
 *  (b) 各ドリンク独立分解モデルで同時飲酒の分解が並列化（杯数倍速）される問題、
 * の両方を回避する。BACが0の待機時間には分解が「たまらない」のがポイント。
 * settings: {weight, sex:"m"|"f"}   session: {start:ms, log:[...]}
 */
function bacAt(session, settings, tMs) {
  if (!session.start || tMs < session.start) return 0;
  const r = R[settings.sex] || R.m;
  const W = settings.weight;
  const stepMs = 60000; // 1分刻み
  let c = 0; // g/L
  let prev = session.start;
  let prevA = 0;
  while (prev < tMs) {
    const cur = Math.min(prev + stepMs, tMs);
    const curA = absorbedGrams(session.log, cur);
    const dtH = (cur - prev) / 3600000;
    c = Math.max(0, c + (curA - prevA) / (W * r) - BETA * dtH);
    prev = cur;
    prevA = curA;
  }
  return c / 10; // g/L → %
}

/**
 * BAC推移グラフ用の時系列。飲み始め〜シラフ予測までを stepMin 分刻みで返す。
 * 戻り値: [{t:ms, bac:%, predicted:bool}]  predicted=true は「今」より未来（追加飲酒なし前提の点線部）
 */
function bacSeries(session, settings, nowMs, stepMin = 5) {
  if (!session.start) return [];
  const end = soberEta(session, settings, nowMs) || nowMs;
  const out = [];
  for (let t = session.start; t <= end + stepMin * 60000; t += stepMin * 60000) {
    out.push({ t, bac: bacAt(session, settings, t), predicted: t > nowMs });
  }
  return out;
}

/**
 * シラフ予測時刻（BACが0.005%未満に戻る時刻ms）。追加飲酒なし前提。
 * 未飲酒なら null。
 */
function soberEta(session, settings, nowMs) {
  if (!session.start) return null;
  const drinks = session.log.filter(e => !e.water);
  if (drinks.length === 0) return null;
  const total = drinks.reduce((s, e) => s + e.g, 0);
  const r = R[settings.sex] || R.m;
  // 全ドリンクの吸収完了時刻。これより前はBACが再上昇しうるため、
  // 「現在BACが低い＝もうシラフ」と即時判定してはいけない（飲んだ直後バグの原因）。
  const absorbEnd = Math.max(...drinks.map(e => e.t)) + ABSORB_MIN * 60000;
  // 探索下限: 「今」と吸収完了時刻の遅い方（これ以降BACは単調減少）
  const lo0 = Math.max(nowMs, absorbEnd);
  if (bacAt(session, settings, lo0) < 0.005) return lo0;
  // 探索上限: 「最終ドリンク時点で全量が残っていた」と仮定した理論的分解完了時刻＋余裕。
  // 実際はそれ以前に一部分解済みのため、ゼロクロスは必ずこれ以前。
  // 念のため上限がまだ閾値以上なら1時間ずつ拡張する（最大72時間で打ち切り）。
  let lo = lo0;
  const lastT = Math.max(...drinks.map(e => e.t));
  let hi = Math.max(lo + 3600000,
    lastT + (total / (settings.weight * r) / BETA) * 3600000 + ABSORB_MIN * 60000);
  while (bacAt(session, settings, hi) >= 0.005 && hi - lo < 72 * 3600000) hi += 3600000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bacAt(session, settings, mid) < 0.005) hi = mid; else lo = mid;
  }
  return Math.round(hi);
}

// ================= 認知機能テスト（適応型） =================
/**
 * 難易度レベル1〜5の計算問題を生成。
 * 戻り値: {text:"47 + 38", answer:85, level}
 * レベル4/5には逆唱課題も混ぜる: {type:"reverse", digits:"52917", answer:"71925", level}
 */
function makeQuestion(level) {
  const ri = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  level = Math.max(1, Math.min(5, level));
  if (level >= 4 && Math.random() < 0.35) {
    const len = level === 4 ? 4 : 5;
    let digits = "";
    for (let i = 0; i < len; i++) digits += ri(i === 0 ? 1 : 0, 9);
    return { type: "reverse", digits, answer: [...digits].reverse().join(""), level };
  }
  let a, b, c, text, answer;
  switch (level) {
    case 1: a = ri(2, 9); b = ri(2, 9); text = `${a} + ${b}`; answer = a + b; break;
    case 2: a = ri(11, 99); b = ri(2, 9);
      if (Math.random() < 0.5) { text = `${a} + ${b}`; answer = a + b; }
      else { text = `${a} − ${b}`; answer = a - b; } break;
    case 3: a = ri(11, 99); b = ri(11, 99);
      if (Math.random() < 0.5) { text = `${a} + ${b}`; answer = a + b; }
      else { [a, b] = [Math.max(a, b), Math.min(a, b)]; text = `${a} − ${b}`; answer = a - b; } break;
    case 4: a = ri(3, 9); b = ri(12, 19); text = `${a} × ${b}`; answer = a * b; break;
    default: a = ri(3, 9); b = ri(11, 19); c = ri(11, 49);
      if (Math.random() < 0.5) { text = `${a} × ${b} + ${c}`; answer = a * b + c; }
      else { text = `${a} × ${b} − ${c}`; answer = a * b - c; } break;
  }
  return { type: "calc", text, answer, level };
}

/** 適応ルール: 正解→+1、不正解→−1（1〜5にクランプ） */
const nextLevel = (level, correct) => Math.max(1, Math.min(5, level + (correct ? 1 : -1)));

/**
 * 1セッション(6問)の採点。
 * results: [{level, correct:bool, ms:回答時間}]
 * 得点 = 正解した問題のレベル合計。5秒以内の正解は+0.5ボーナス。
 * 満点近似 = 開始レベルから全問正解した場合のレベル合計。
 * 戻り値: {score, maxScore, pct}
 */
function scoreQuiz(results, startLevel = 2) {
  let score = 0;
  for (const r of results) {
    if (r.correct) score += r.level + (r.ms <= 5000 ? 0.5 : 0);
  }
  let maxScore = 0, lv = startLevel;
  for (let i = 0; i < results.length; i++) { maxScore += lv + 0.5; lv = Math.min(5, lv + 1); }
  return { score, maxScore, pct: Math.round(score / maxScore * 100) };
}

/**
 * 認知機能インデックス（基準比%）。
 * baselinePct: シラフ時に測定したスコアpct（未測定ならnull→絶対値をそのまま返す）
 */
function cognitiveIndex(currentPct, baselinePct) {
  if (!baselinePct) return { pct: currentPct, relative: false };
  return { pct: Math.min(150, Math.round(currentPct / baselinePct * 100)), relative: true };
}

/**
 * 飲みIQのコメントプール。段階ごとにランダム抽選して毎回違うセリフを出す。
 * UI側で追加・差し替え自由（配列に足すだけ）。
 */
const IQ_COMMENTS = {
  genius: [ // 130: 基準超えの絶好調
    "冴えすぎ。今夜のあなたは天才です（本当に飲んでる？）",
    "アインシュタインが酒場に迷い込んだ",
    "飲めば飲むほど強くなる……それ、少年漫画の主人公",
    "泰然自若。醸造所が裸足で逃げ出すレベル",
    "ソクラテスが「君と飲みたい」と申しております",
    "大器晩成ならぬ大器晩酌",
    "その冴え、信長なら即家臣に取り立てる",
    "今夜の発言、後世の名言集に載る説",
    "シラフ超え。逆にちょっと心配",
    "シラフの自分を追い越しました。追い越し車線です",
    "脳内CPU、なぜかオーバークロック中",
    "今日のあなた、計算問題に酔いが追いついていない",
    "冴えすぎ注意。重要な契約だけは明日にしよう",
    "知性がグラスからあふれています",
    "酒場に現れた異常値",
    "本日の暗算王、暫定首位",
    "脳だけ二次会を断って帰宅済み",
    "酔っているのに精度が高い。ミステリーです",
    "天才と酔っぱらいは紙一重。今は天才側",
    "問題を解く速度が注文より速い",
    "居酒屋の照明が後光に見えてきた",
    "その頭脳、割り勘担当に正式任命",
    "思考回路、奇跡的に全線開通",
    "今夜のあなたには模範解答が似合う",
    "脳内の全社員が残業しています",
    "酔いより先に答えへ到着",
    "冷静沈着。氷より冷静",
    "このスコアは明日の自分に自慢してよい",
    "才気煥発。ただし追加注文は慎重に",
    "全問正解の顔で水を頼むとさらにカッコいい",
    "思考のキレ、レモンサワーより鋭い",
    "まだ酔いより理性の声が大きい",
    "頭脳だけ先にシラフへ帰還しました",
  ],
  sharp: [ // 120-129: シラフの切れ味キープ
    "シラフの切れ味キープ。品行方正",
    "まだ会議に出られる顔をしている",
    "ニュートンがりんごを見つける直前くらいの冷静さ",
    "頭脳明晰。乾杯の挨拶を任せたい",
    "一休さんもニッコリのとんち力",
    "余裕綽々。ただし油断大敵",
    "知性が肴より先に残っている",
    "文武両道ならぬ飲文両道",
    "「まだ大丈夫」が本当に大丈夫な、貴重な時間帯",
    "シラフ時の性能をほぼ維持。優秀です",
    "まだ暗算で割り勘できます",
    "頭の回転、まだ高速道路",
    "理性、本日も通常営業",
    "酔いの侵入を水際で防いでいます",
    "会話の伏線をまだ回収できる",
    "まだ同じ話を二度していないはず",
    "判断力、欠勤なし",
    "脳内ネットワーク、通信良好",
    "スマホを落としてもすぐ気づけるレベル",
    "まだ終電時刻を正確に言えそう",
    "この状態で締めれば明日が楽",
    "思考の輪郭、まだくっきり",
    "今なら財布・鍵・携帯を全部確認できる",
    "知性と酒量のバランスが絶妙",
    "脳内会議、議事録まで残っています",
    "まだ注文履歴を覚えている。強い",
    "余裕があります。余裕があるうちに水を",
    "記憶の保存ボタン、まだ有効",
    "会計でゼロを一つ増やす心配は少なそう",
    "冷静さ、氷入り",
    "この切れ味を保ったまま帰るのが上級者",
    "まだ「大丈夫」が信用できる時間帯",
    "酔いと理性、現在は理性が判定勝ち",
    "ここで一杯止めると伝説ではなく美談になります",
  ],
  okay: [ // 110-119: まだ大丈夫（そう）
    "ほろ酔いの哲学者。語りが長くなる前兆あり",
    "まだいける。ただし「まだいける」は魔法の呪文ではない",
    "エンジン温まってきた。ここでピットインも渋い選択",
    "酒は飲んでも飲まれていない……今のところ",
    "李白なら詩を詠み始める頃合い",
    "頭の回転、常温のビールくらいにぬるくなってきた",
    "次の一杯は「選ばれし一杯」にしよう",
    "「まだ大丈夫そう」。フラグにも聞こえる",
    "少しほぐれてきました。ほどほどゾーン",
    "まだ正常運転。ただし黄色信号",
    "頭の回転に少し氷が溶けてきた",
    "良い感じ。でも良い感じは長く続かない",
    "今がきれいに終われる分岐点",
    "会話は滑らか、判断は少し甘め",
    "「もう一杯」が魅力的に見え始める頃",
    "脳内Wi-Fi、アンテナ2本",
    "記憶の画質が4KからフルHDになりました",
    "このあたりで水を入れると玄人感が出ます",
    "楽しいと危ないの境界線に接近中",
    "明日の自分がまだ笑って許せる範囲",
    "ちょうどよい酔い。ちょうどよいうちに締めたい",
    "思考に少しだけ泡が混ざっています",
    "まだLINEを送る前に読み直せます",
    "終電検索は今のうち",
    "酔いのアクセル、少し踏み込みました",
    "判断力、まだ現役。ただしベテラン疲労あり",
    "まだ店員さんの説明が一度で入る",
    "ここで水を選ぶと明日の自分から表彰されます",
    "楽しい夜のまま保存できるタイミング",
    "「最後の一杯」が本当に最後なら優秀",
    "まだ方向感覚は北を向いている",
    "会計前に人数を数えられるうちに締めよう",
    "記憶のバックアップ推奨タイム",
  ],
  slipping: [ // 100-109: 少し落ちてきた
    "少し落ちてきた。水を1杯はさもう",
    "脳がアルコールに家賃を払い始めた",
    "猿も木から落ちる。あなたも椅子から落ちる前に水を",
    "二兎を追う者は一兎をも得ず。酒と理性、どっちを取る？",
    "ダ・ヴィンチも筆を置く時間帯",
    "ここが天王山。水分補給で流れを変えろ",
    "温故知新。前回の失敗を思い出すなら今",
    "脳内処理に待ち時間が発生しています",
    "答えが喉まで来て、そのまま帰りました",
    "計算問題にも酔いが回ってきました",
    "思考の読み込み速度が低下中",
    "脳内タブを開きすぎています",
    "今なら水一杯で流れを戻せます",
    "「何の話だっけ」がそろそろ増える頃",
    "記憶の自動保存が不安定です",
    "誤字脱字が元気になる時間帯",
    "次の注文より帰り道を検索しよう",
    "頭の中で円が少し楕円になっています",
    "暗算が相談案件になってきました",
    "脳のピント、少し甘い",
    "話の結論が遠回りし始めました",
    "スマホの入力ミス、増えていませんか",
    "同じ話の再放送に注意",
    "今の水は、明日の鎮痛薬より価値がある",
    "酔いが理性の席に座り始めました",
    "会話の主語が迷子になる前に締めよう",
    "ここから先は楽しいより雑になりやすい",
    "まだ引き返せる。出口は水の向こう",
    "判断力、現在やや渋滞中",
    "メニューの文字が増えたように感じたら終了です",
    "今日を良い夜にする最後の編集タイム",
    "飲むより止めるほうが難しい。だから今が見せ場",
  ],
  drunk: [ // 85-99: だいぶ酔い
    "だいぶ酔ってます。次で締めるのが吉",
    "前後不覚まであと数歩。引き返すなら今",
    "覆水盆に返らず。飲んだ酒も戻らず",
    "記憶のセーブポイントはこの辺です",
    "武士の情け。ここで納刀といこう",
    "英雄も酒には勝てず。ナポレオンはもう寝た",
    "グラスの底に、明日の後悔が沈殿し始めた",
    "脳内の責任者が退勤しました",
    "記憶の録画容量が残りわずかです",
    "ここからの一杯は明日の後悔へ直送されます",
    "携帯・財布・鍵を今すぐ確認",
    "帰れるうちに帰る。それが勝ちです",
    "理性が小声になっています",
    "「全然酔ってない」は信用できない時間帯",
    "会話のループ再生が始まる前に終了",
    "明日の予定を守るなら、今が撤収時",
    "水と会計、順番はどちらでも正解",
    "記憶の画質が急に粗くなっています",
    "次の一杯よりタクシーの到着時間を確認",
    "ここで止めれば「楽しかった」で終われます",
    "酔いのハンドルが少し効きにくい",
    "グラスよりスマホを置き忘れないで",
    "明日の自分が緊急会議を招集しています",
    "話の着地点が行方不明です",
    "あなたの肝臓、閉店準備に入りました",
    "今ならまだ、自分で終了ボタンを押せます",
    "帰宅できる判断力を最後に使おう",
    "この先は思い出より証言が増えます",
    "記憶がない夜は、楽しかった証明にはなりません",
    "追加注文より、水と炭水化物",
    "今の撤収は敗北ではなくファインプレー",
    "酔いは十分。夜も十分。帰ろう",
  ],
  closed: [ // <85: 店じまい
    "今夜はもう店じまい。よく頑張った",
    "後悔先に立たず。でも水は今からでも役に立つ",
    "脳内会議、全会一致で閉会を可決",
    "ゲームオーバー。コンティニューは水とおつまみで",
    "立つ鳥跡を濁さず。会計と水、忘れずに",
    "見事な散り際。ここからは花道です",
    "本日の脳内営業は終了しました",
    "これ以上は明日の自分への無断請求です",
    "水を飲んで、座って、帰宅手段を確保しよう",
    "記憶の保存に失敗する前にログアウト",
    "今日の最適解は追加注文ではありません",
    "今夜のクライマックスはもう終わりました",
    "ここから先はエンドロールです",
    "グラスを置けば、それだけで満点",
    "帰宅ボタンが今夜いちばん賢い選択",
    "これ以上の延長戦はありません",
    "財布・携帯・鍵・上着。順番に確認",
    "一人で歩かず、必要なら誰かに声をかけよう",
    "眠気が強いなら一人にしないでもらおう",
    "今日はもう数字と戦わなくていい",
    "今は水。話は明日",
    "追加の一杯は思い出ではなく空白を増やします",
    "帰る決断が今夜のベストプレー",
    "今夜の称号は「無事に帰った人」で十分",
    "ここから先は勇気ではなく撤退戦",
    "きれいな終わり方は、今でも選べます",
    "明日のあなたを救えるのは現在のあなたです",
    "店じまいです。水を飲んで会計へ",
    "もう盛り上げなくて大丈夫",
    "今夜の物語はここで完結",
    "最後のミッション: 安全に帰宅",
  ],
};

/**
 * 状況別コメント。tierコメントとは独立に、UIの各場面で使う。
 * drop/bigDrop は drinkIQ() が内部で自動合成（最大2文ルール）。
 * water/limit70/limitOver/lastTrain/lateNight は contextComment(type) でUIから呼ぶ。
 */
const CONTEXT_COMMENTS = {
  drop: [ // 前回よりIQが5以上低下
    "前回より落ちています。酔いは正直",
    "さっきより脳の通信速度が落ちました",
    "スコア下降中。グラスは上げずに水を上げよう",
    "落差あり。ここで止めると被害は最小",
    "前回の自分から警告が届いています",
    "数字が「今日はここまで」と言っています",
    "さっきの冴えは二次会へ行きました",
    "認知機能、下り坂に入りました",
    "落ち始めたら早い。今がブレーキ",
    "前回との差が、追加注文への回答です",
    "脳の電波が一段弱くなりました",
    "まだ帰宅判断は残っています",
    "スコアが下がるほど水の価値が上がります",
    "低下確認。ここからは回復優先",
    "今夜のピークはもう越えたようです",
  ],
  bigDrop: [ // 前回よりIQが15以上低下
    "落差が滝。見物せず帰ろう",
    "急降下です。シートベルト代わりに水を",
    "脳内エレベーターが地下へ向かっています",
    "数字がかなり本気で止めに来ています",
    "ここまで落ちたら次の一杯は不要",
    "前回の自分と別人判定",
    "低下幅、大。終了ボタンの出番です",
    "脳の省電力モードが強制起動",
    "急な低下は、酔いが進んだサイン",
    "今夜の追加注文、統計的に否決",
    "判断力が一段ではなく数段落ちました",
    "ここで帰ると明日の損失を止められます",
  ],
  water: [ // 水を記録した直後
    "水入りました。ナイス判断",
    "その一杯、今夜でいちばん価値があるかも",
    "水分補給、理性から拍手",
    "良いインターバルです",
    "水を頼める人は強い",
    "ここで水を選べるのが本当の酒豪",
    "肝臓から感謝状が届きました",
    "その水、明日の自分への投資です",
    "ペース調整、成功",
    "グラスは同じでも中身が違う。賢い",
    "水で一度、夜をリセット",
    "判断力が仕事をしました",
    "ナイス給水。焦らずいこう",
    "水をはさむ。それだけで流れが変わる",
    "今夜のMVP候補、水",
  ],
  limit70: [ // 上限の70%到達バナー
    "次を最後にするなら、今決めておこう",
    "楽しいまま終われるラインに来ました",
    "上限が見えてきました。水を先に",
    "ここからは一杯の重みが増します",
    "まだ余裕はある。でも余裕は貯金できません",
    "最後の一杯を選ぶ時間です",
    "次の注文前にシラフ予測を見てみよう",
    "ここでペースを落とすと明日が楽",
    "上限接近。理性はまだ味方です",
    "良い夜の着地点が見えてきました",
  ],
  limitOver: [ // 上限超過バナー
    "上限を越えました。ここからは回復ターン",
    "今日はもう十分飲みました",
    "次の一杯より、帰宅準備",
    "数字上は閉店時間です",
    "追加注文は明日の自分が拒否しています",
    "上限超過。水と会計が最適解",
    "今夜の酒量はもう完成しています",
    "これ以上足さなくても、十分な夜です",
    "延長戦にメリットは少なめです",
    "ここで止めると被害を広げずに済みます",
  ],
  lastTrain: [ // 22時以降・終電前の帯
    "終電と理性、どちらも待ってくれません",
    "今帰れば電車、次はタクシー",
    "終電検索は酔う前の自分への礼儀",
    "その一杯、終電一本分かもしれません",
    "帰宅ルートを今のうちに確保",
    "駅まで歩けるうちに動こう",
    "最後の注文より最後の電車",
    "終電に乗る人が今夜の勝者",
    "駆け込み乗車より余裕の帰宅",
    "電車があるうちに、理性も一緒に帰ろう",
  ],
  lateNight: [ // 0時以降
    "夜が深いほど判断は浅くなりがち",
    "時計は正直です。そろそろ帰ろう",
    "午前様になる前に終了",
    "深夜の一杯は翌朝に響きやすい",
    "店は開いていても脳は閉店間近",
    "時刻と酒量、両方が進んでいます",
    "眠気と酔いの合流地点です",
    "夜更かしと飲み過ぎのセット販売に注意",
    "ここからは飲酒より睡眠の価値が高い",
    "明日が近づいています。帰ろう",
  ],
};

/**
 * 成績表用の称号（達成条件付き）。pickTitle() が条件でフィルタしてから抽選するため、
 * 「上限超過なのに上限内フィニッシャー」のような事故は起きない。
 * ctx: {card: scorecardの戻り値, session, endTime:ms, cogIndexPct:number|null}
 */
const _badge = (ctx, label) => ctx.card.badges.some(b => b.label === label && b.ok);
const _hour  = t => new Date(t).getHours();
const _drinks = ctx => ctx.session ? ctx.session.log.filter(e => !e.water).length : 0;
const _waters = ctx => ctx.session ? ctx.session.log.filter(e => e.water).length : 0;
const IQ_TITLES = [
  { title: "シラフの守護者",         eligible: c => c.card.badges.length > 0 && c.card.badges.every(b => b.ok) },
  { title: "上限内フィニッシャー",   eligible: c => _badge(c, "上限内で着地") },
  { title: "肝臓との和平交渉人",     eligible: c => _badge(c, "上限内で着地") },
  { title: "一杯を断れる勇者",       eligible: c => _badge(c, "上限内で着地") && c.card.totalG > 0 },
  { title: "水分補給の達人",         eligible: c => _badge(c, "こまめに水分") },
  { title: "水を愛し、水に愛された者", eligible: c => _drinks(c) > 0 && _waters(c) >= _drinks(c) },
  { title: "ペース配分の職人",       eligible: c => _badge(c, "ペース良好") },
  { title: "飲み会のリスク管理者",   eligible: c => _badge(c, "ペース良好") && _badge(c, "こまめに水分") },
  { title: "明日の自分の恩人",       eligible: c => _badge(c, "節度ある適度な飲酒") },
  { title: "終電の賢者",             eligible: c => _hour(c.endTime) >= 18 && _hour(c.endTime) < 23 },
  { title: "帰宅判断の名人",         eligible: c => _hour(c.endTime) >= 5 && c.card.grade !== "D" && _badge(c, "上限内で着地") },
  { title: "記憶を持ち帰った人",     eligible: c => c.cogIndexPct != null && c.cogIndexPct >= 80 },
  { title: "会計前に正気を保った人", eligible: c => c.cogIndexPct != null && c.cogIndexPct >= 80 },
  { title: "酒場の冷静王",           eligible: c => c.cogIndexPct != null && c.cogIndexPct >= 90 },
  { title: "ブラックアウト回避者",   eligible: c => c.cogIndexPct != null && c.cogIndexPct >= 70 },
  { title: "記憶保存成功",           eligible: c => c.cogIndexPct != null && c.cogIndexPct >= 75 },
  { title: "撤収判断Sランク",        eligible: c => c.card.grade === "S" },
  { title: "美しく締めた人",         eligible: c => ["S", "A"].includes(c.card.grade) },
  { title: "楽しいまま帰れた人",     eligible: c => ["S", "A"].includes(c.card.grade) },
  { title: "明日を守った夜",         eligible: c => c.card.grade !== "D" },
];

/**
 * 達成条件を満たす称号からランダムに1つ選ぶ。該当なしは「無事に帰った人」。
 * 呼び方: pickTitle({card, session, endTime: Date.now(), cogIndexPct})
 */
function pickTitle(ctx) {
  const pool = IQ_TITLES.filter(t => { try { return t.eligible(ctx); } catch { return false; } });
  if (pool.length === 0) return "無事に帰った人";
  return pool[Math.floor(Math.random() * pool.length)].title;
}

/** 同じコメントの連続を避ける抽選。previousには直前に表示した文字列を渡す（画面セッション内保持でよい） */
function pickWithoutRepeat(pool, previous) {
  if (!pool || pool.length === 0) return "";
  if (pool.length === 1) return pool[0];
  let selected;
  do { selected = pool[Math.floor(Math.random() * pool.length)]; } while (selected === previous);
  return selected;
}

/**
 * 飲みIQ: 認知テスト結果をIQ風スケールで見せるお遊び指標（表示専用）。
 * シラフの自分＝120とし、低下幅を1.5倍に増幅して変化を体感しやすくする。
 * 基準を大きく超える絶好調時のみ最高値130が出る。
 * コメントは段階別プールからランダム抽選。prevIq（前回の飲みIQ）を渡すと
 * 低下幅に応じたコメントを1文追加合成する（最大2文ルール）。
 * 【重要】警告判定・scorecard()には飲みIQではなく cognitiveIndex().pct を使うこと。
 * 医学的なIQ・認知機能検査ではない（UIに必ず「シラフの自分＝120」と明記すること）。
 * 戻り値: {iq:40-130, tier, comment}
 */
function drinkIQ(currentPct, baselinePct, prevIq = null) {
  const base = baselinePct || 100;
  const iq = Math.max(40, Math.min(130, Math.round(120 + (currentPct / base - 1) * 150)));
  const tier =
    iq >= 130 ? "genius" :
    iq >= 120 ? "sharp" :
    iq >= 110 ? "okay" :
    iq >= 100 ? "slipping" :
    iq >= 85  ? "drunk" : "closed";
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  let comment = pick(IQ_COMMENTS[tier]);
  if (prevIq != null && prevIq - iq >= 15)     comment += " " + pick(CONTEXT_COMMENTS.bigDrop);
  else if (prevIq != null && prevIq - iq >= 5) comment += " " + pick(CONTEXT_COMMENTS.drop);
  return { iq, tier, comment };
}

/**
 * 状況別コメントの抽選。UIの各場面で呼ぶ。
 * type: "water" | "limit70" | "limitOver" | "lastTrain" | "lateNight"
 * previous: 直前に表示した同タイプのコメント（連続表示回避。省略可）
 */
function contextComment(type, previous) {
  const pool = CONTEXT_COMMENTS[type];
  return pool ? pickWithoutRepeat(pool, previous) : "";
}

// ================= 今夜の成績表 =================
/**
 * セッション終了時のスコアカード。
 * cogIndexPct: 飲酒中テストの最終インデックス（未実施ならnull）
 * 戻り値: {points, grade, badges:[{ok,label}]}
 */
function scorecard(session, settings, cogIndexPct) {
  const drinks = session.log.filter(e => !e.water);
  const waters = session.log.filter(e => e.water);
  const total = drinks.reduce((s, e) => s + e.g, 0);
  // ペース違反: いずれかの60分窓で settings.pace g超
  let paceViolated = false;
  for (const e of drinks) {
    const win = drinks.filter(x => x.t >= e.t && x.t < e.t + 3600000)
                      .reduce((s, x) => s + x.g, 0);
    if (win > settings.pace) { paceViolated = true; break; }
  }
  const badges = [
    { ok: total <= settings.limit,                          label: "上限内で着地",       pts: 40 },
    { ok: !paceViolated,                                    label: "ペース良好",         pts: 20 },
    // 酒2杯につき水1杯（切り上げ: 1杯→水1、3杯→水2）。1杯でも水ゼロなら未達成
    { ok: drinks.length === 0 || waters.length >= Math.ceil(drinks.length / 2), label: "こまめに水分", pts: 15 },
    // テスト未実施は達成扱いにしない（skipped=trueをUIは「未測定」と表示。◯✕にしない）
    // 未実施の最高グレードはA止まり＝テスト実施への意図的なインセンティブ
    { ok: cogIndexPct != null && cogIndexPct >= 80, skipped: cogIndexPct == null, label: "認知機能キープ", pts: 15 },
    { ok: total <= 20,                                      label: "節度ある適度な飲酒", pts: 10 },
  ];
  const points = badges.reduce((s, b) => s + (b.ok ? b.pts : 0), 0);
  const grade = points >= 90 ? "S" : points >= 75 ? "A" : points >= 60 ? "B" : points >= 40 ? "C" : "D";
  return { points, grade, badges, totalG: Math.round(total * 10) / 10 };
}

/** 上限内達成の連続日数（履歴の新しい順に数える。休肝日もストリーク継続扱い） */
function streak(history, limit) {
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let n = 0;
  for (const h of sorted) { if (h.g <= limit) n++; else break; }
  return n;
}

// ================= 翌朝の振り返り =================
/**
 * 失敗ライン推定: 「後悔度5以上」だった夜の摂取量の最小値と、
 * 「後悔度4以下」の夜の最大値の中間を"あなたの限界ライン"として返す。
 * reviews: [{date, g, hangover:0-10, regret:0-10}]
 * データ不足なら null。
 */
function estimateFailureLine(reviews) {
  const bad = reviews.filter(r => r.regret >= 5 || r.hangover >= 5).map(r => r.g);
  const good = reviews.filter(r => r.regret < 5 && r.hangover < 5).map(r => r.g);
  if (bad.length === 0) return null;
  const minBad = Math.min(...bad);
  const maxGoodBelow = good.filter(g => g < minBad);
  const lower = maxGoodBelow.length ? Math.max(...maxGoodBelow) : minBad * 0.7;
  return Math.round((minBad + lower) / 2);
}

// ================= 設定値のサニタイズ =================
/**
 * 不正な設定値（体重0kg等）を安全な範囲にクランプして返す。
 * UI層は設定の読み込み・保存時に必ずこれを通すこと。
 */
function sanitizeSettings(s) {
  const src = (s && typeof s === "object") ? s : {};
  const clamp = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    weight: clamp(src.weight, 30, 200, 65),
    sex: src.sex === "f" ? "f" : "m",
    limit: clamp(src.limit, 10, 150, 40),
    pace: clamp(src.pace, 5, 100, 20),
    baselinePct: src.baselinePct == null ? null : clamp(src.baselinePct, 1, 100, null),
  };
}

// ================= localStorage スキーマ =================
/**
 * dcSettings : {weight:65, sex:"m", limit:40, pace:20, baselinePct:null}
 * dcSession  : {start:ms|null, log:[{t,name,emoji,g,water,price?}],
 *               quizzes:[{t, pct, indexPct}]}
 * dcHistory  : [{date:"YYYY-MM-DD", g, cups, grade?, points?}]
 * dcReviews  : [{date:"YYYY-MM-DD", g, hangover:0-10, regret:0-10,
 *                symptoms:["頭痛",...], meds:["五苓散",...], memo?}]
 */

// Node.js テスト用エクスポート（ブラウザでは無視される）
if (typeof module !== "undefined") {
  module.exports = { DRINKS, SYMPTOMS, MEDS, pureAlcoholG, localKey, stageOf, absorbedGrams, bacAt,
    bacSeries, soberEta, makeQuestion, nextLevel, scoreQuiz, cognitiveIndex,
    drinkIQ, contextComment, pickWithoutRepeat, pickTitle, IQ_COMMENTS, CONTEXT_COMMENTS,
    IQ_TITLES, SAFETY_NOTICE, scorecard, streak, estimateFailureLine, sanitizeSettings };
}
