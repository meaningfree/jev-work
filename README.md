# くらしの希望から検索条件をつくる

住み替えの希望を自由入力で書いてもらい、**不動産ポータル（ホームズ・スーモなど）の検索条件を確率つきで提案する**小さな Web アプリ。
「何をどう絞ればいいか分からない人」に、すでに決まっている情報から検索条件を組み立ててもらうための補助が狙い。

[Jev / TypeSafe System One](https://docs.typesafe.ai/) のお試しとして作っている。
Jev は文章を生成せず、**型つきの質問に対して確率つきの答えを返す**モデルなので、「この人の条件は 3LDK が 71%、2LDK が 22%」のような出し方がそのまま作れる。

```
index.html            画面
assets/questions.js   ★ Jev に投げる質問の定義（この仕組みの本体）
assets/app.js         画面の組み立て・API 呼び出し
assets/mock.js        API キーが無いときのデモ用ダミー推論（キーワードマッチ）
assets/styles.css
assets/interpret.js   レスポンスを検索条件に読み替える部分（画面と CLI で共用）
proxy/cloudflare-worker.js  API キーを持つ中継サーバー（Cloudflare Workers）
proxy/dev-server.mjs        ローカル確認用（静的配信＋中継）
proxy/try-jev.mjs           実 API を 1 回だけ叩いて結果を表示する CLI
```

## 動かし方

### 1. デモモード（API キー不要）

そのまま `index.html` を配信するだけ。キーワードマッチのダミー推論で画面の挙動を確認できる。

```bash
npx http-server . -p 8080     # あるいは node proxy/dev-server.mjs
```

### 2. まず API の手応えだけ見る（CLI）

画面と同じ質問定義で 1 回だけ実 API を叩く。

```bash
TYPESAFE_API_KEY=sk-... node proxy/try-jev.mjs "夫婦と子ども2人。いま2LDKで手狭で購入を検討中。..."
TYPESAFE_API_KEY=sk-... node proxy/try-jev.mjs --json "..."   # 生レスポンス
```

おすすめ条件・まだ聞けていないこと・全選択肢の分布に加えて、レイテンシと入力トークン数・概算コストが出る。

### 3. Jev の実 API につなぐ（画面から）

Jev の API は**ブラウザからの直接呼び出しを CORS で拒否する**（`Disallowed CORS origin`）。
API キーもフロントに置けないので、キーを持つ中継を 1 枚挟む必要がある。

ローカル確認:

```bash
TYPESAFE_API_KEY=sk-... node proxy/dev-server.mjs
# http://localhost:8787 を開き、画面下部「API の接続設定」に
# http://localhost:8787/jev を入れて保存
```

公開用（Cloudflare Workers・無料枠で足りる）:

```bash
cd proxy
npx wrangler deploy
npx wrangler secret put TYPESAFE_API_KEY   # sk-... を貼る
npx wrangler secret put ALLOWED_ORIGINS    # https://<ユーザー名>.github.io
# → 出力された https://xxx.workers.dev を画面の接続設定に入れる
```

接続先 URL はブラウザの localStorage にだけ保存される。空欄にするとデモモードに戻る。

### 4. GitHub Pages で公開

リポジトリの Settings → Pages → Source を `Deploy from a branch`、ブランチを `main` / `(root)` にするだけ。
ビルド不要の静的ファイルしか置いていない。

## Jev の API キーと支払いについて

- キーの発行は [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys)（2026/09 時点で early access、ウェイトリスト経由）。
- 料金は**入力 100 万トークンあたり $0.042 / 出力は無料**。このアプリの 1 リクエストは質問定義込みで 3,000 トークン前後なので、**1 回およそ $0.0001（0.02 円前後）**。1 万回叩いて数ドル。
- 支払いはクレジット前払い方式（コンソールの Billing でクレジットを購入、残高が閾値を下回ったときの自動追加はオプトイン）。明示的な無料枠は公表されていないので、残高ゼロだと `402` / `403` が返る。まずはキーだけでそのまま叩いてみて、エラーが出たらクレジットを買えばよい。
- TypeSafe に直接登録したくない場合は、Cloudflare Workers AI（モデル ID `typesafe/jev`）や Vercel AI Gateway 経由でも同じモデルを呼べる。その場合は Cloudflare / Vercel 側の課金になり、`proxy/` の転送先をそちらに差し替える。

## 仕組み

`assets/questions.js` が全て。自由入力文を `state` として渡し、検索条件の各軸を Jev の 3 つの質問型に割り当てている。

| 質問型 | 返るもの | 使っている軸 |
| --- | --- | --- |
| `choice` | 選択肢ごとの確率＋確信度 | 取引の種類（賃貸/購入）、建物種別、間取り、エリアの性格、最重視する軸 |
| `score` | 順序つきレベルごとの確率＋期待値 | 広さ、駅からの距離、築年数、予算の優先度、入居時期の急ぎ度 |
| `noul` | はい/いいえの確率（0〜1） | ペット可・駐車場・日当たり などのこだわり条件 10 件 |

リクエストは 1 回で全質問を評価する（Jev は 1 リクエストに複数の質問を入れられる）。

画面では 3 つの見せ方をしている。

1. **おすすめ検索条件** — 各軸の最有力候補と、その確率。
2. **まだ聞けていないこと** — 確率が割れている軸（最有力でも 45% 未満）と、判断がつかないこだわり条件。
   これが「条件が明確でない人」向けの本命で、*次に何を聞けば条件が締まるか* がそのまま出る。
3. **項目ごとの確率** — 全選択肢の分布。候補の 2 番手を見ながら条件を緩める判断に使う。

条件を足したい・言い換えたいときは `assets/questions.js` の `AXES` / `FLAGS` に足すだけでよい。UI もコピー用メモも自動で追従する。

## 注意

- 確率は Jev が返す calibrated probability をそのまま表示している。「その条件で検索するのが妥当そうな度合い」であって、成約率や物件の当たりやすさではない。
- ポータルサイトへの検索 URL 生成まではやっていない（各社のクエリ仕様に依存するため）。条件はテキストでコピーできる。
