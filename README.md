# くらしの希望から検索条件をつくる

住み替えの希望を自由入力で書いてもらい、**不動産ポータル（ホームズ・スーモなど）の検索条件を確率つきで提案する**小さな Web アプリ。
「何をどう絞ればいいか分からない人」に、すでに決まっている情報から検索条件を組み立ててもらうための補助が狙い。

[Jev / TypeSafe System One](https://docs.typesafe.ai/) のお試しとして作っている。
Jev は文章を生成せず、**型つきの質問に対して確率つきの答えを返す**モデルなので、「この人の条件は 3LDK が 71%、2LDK が 22%」のような出し方がそのまま作れる。

```
public/index.html            画面
public/assets/questions.js   ★ Jev に投げる質問の定義（この仕組みの本体）
public/assets/app.js         画面の組み立て・API 呼び出し
public/assets/interpret.js   レスポンスを検索条件に読み替える部分（画面と CLI で共用）
public/assets/mock.js        中継が無いときのデモ用ダミー推論（キーワードマッチ）
public/assets/styles.css
worker.js                    画面の配信と Jev への中継を兼ねる Cloudflare Worker
wrangler.toml                その設定（public/ を配信し、/jev だけ worker.js が処理する）
proxy/upstream.mjs           Jev に投げる部分（Worker とローカル用サーバーで共用）
proxy/dev-server.mjs         ローカル確認用（Node だけで動く。静的配信＋中継）
proxy/try-jev.mjs            実 API を 1 回だけ叩いて結果を表示する CLI
```

## なぜ中継サーバーが要るのか

Jev の API は**ブラウザからの直接呼び出しを CORS で拒否する**。

```
$ curl -i -X OPTIONS https://api.typesafe.ai/v1/systemone -H 'Origin: https://example.github.io'
HTTP/2 400
Disallowed CORS origin
```

API キーもフロントには置けないので、キーを持つ中継を 1 枚挟むしかない。
このリポジトリでは**画面の配信と中継を同じ Worker でやる**ことでそれを 1 回のデプロイに収めている。
同一オリジンなので CORS の設定も要らず、画面側の接続設定も不要（起動時に同じオリジンの `/jev` を自動で探す）。

中継が無いところ（静的ホスティングにそのまま置いた場合など）では、キーワードマッチの**デモモード**で動く。

## 動かし方

### 1. 公開する（Cloudflare Workers・無料枠で足りる）

```bash
npx wrangler deploy                        # public/ と worker.js がまとめて上がる
npx wrangler secret put TYPESAFE_API_KEY   # sk-... を貼る
```

出力された `https://jev-search-generator.<アカウント>.workers.dev` を開けばそのまま実 API で動く。
キーは Worker のシークレットに入るだけで、ブラウザには一切出ない。

### 2. ローカルで確認する

Cloudflare の実行環境そのままで試す場合:

```bash
echo 'TYPESAFE_API_KEY="sk-..."' > .dev.vars   # .gitignore 済み
npx wrangler dev                               # → http://localhost:8787
```

Node だけで済ませたい場合（Cloudflare アカウント不要）:

```bash
TYPESAFE_API_KEY=sk-... node proxy/dev-server.mjs   # → http://localhost:8787
```

どちらも画面と `/jev` が同一オリジンになるので、本番と同じ経路で確認できる。
キーを渡さずに起動すると画面はデモモードになる。

### 3. API の手応えだけ先に見る（CLI）

画面と同じ質問定義で 1 回だけ実 API を叩く。

```bash
TYPESAFE_API_KEY=sk-... node proxy/try-jev.mjs "夫婦と子ども2人。いま2LDKで手狭で購入を検討中。..."
TYPESAFE_API_KEY=sk-... node proxy/try-jev.mjs --json "..."   # 生レスポンス
```

おすすめ条件・まだ聞けていないこと・全選択肢の分布に加えて、レイテンシと入力トークン数・概算コストが出る。

### 4. デモだけ公開したい場合

`public/` の中身をそのまま GitHub Pages などの静的ホスティングに置けば、デモモードのページとして動く。
中継が無いので実 API にはつながらない。

### 接続先を手で指定したいとき

画面下部の「API の接続設定」に別に立てた中継の URL を入れると、そちらを使う。
設定はブラウザの localStorage にだけ保存され、「自動に戻す」で元に戻る。

## Jev の API キーと支払いについて

- キーの発行は [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys)（2026/09 時点で early access、ウェイトリスト経由）。
- 料金は**入力 100 万トークンあたり $0.042 / 出力は無料**。このアプリの 1 リクエストは質問定義込みで 3,000〜3,500 トークン程度（実測: 2,401 トークン / 444ms / jev-1.13.0）なので、**1 回およそ $0.0001（0.02 円前後）**。1 万回叩いて 1〜2 ドル。
- 支払いはクレジット前払い方式（コンソールの Billing でクレジットを購入、残高が閾値を下回ったときの自動追加はオプトイン）。明示的な無料枠は公表されていないので、残高ゼロだと `402` / `403` が返る。まずはキーだけでそのまま叩いてみて、エラーが出たらクレジットを買えばよい。
- TypeSafe に直接登録したくない場合は、Cloudflare Workers AI（モデル ID `typesafe/jev`）や Vercel AI Gateway 経由でも同じモデルを呼べる。その場合は Cloudflare / Vercel 側の課金になり、`proxy/upstream.mjs` の `UPSTREAM` をそちらに差し替える。

## 仕組み

`assets/questions.js` が全て。自由入力文を `state` として渡し、検索条件の各軸を Jev の 3 つの質問型に割り当てている。

| 質問型 | 返るもの | 使っている軸 |
| --- | --- | --- |
| `choice` | 選択肢ごとの確率＋確信度 | 取引の種類（賃貸/購入）、建物種別、間取り、エリアの性格、最重視する軸 |
| `score` | 順序つきレベルごとの確率＋期待値 | 広さ、駅からの距離、築年数、予算の優先度、入居時期の急ぎ度 |
| `noul` | はい/いいえの確率（0〜1） | ペット可・駐車場・日当たり などのこだわり条件 10 件 |

`noul` には `criteria` で true / false の条件を明示している。これが無いと、入力に手がかりの無いこだわり条件まで 0.4〜0.5 に張り付き、「まだ聞けていないこと」が水増しされる。

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
- 公開した `/jev` は**誰でも叩ける**。呼ばれた分だけこちらのクレジットを消費する（1 回 $0.0001 程度）。
  気になる場合は Cloudflare の Rate Limiting を当てるか、`worker.js` で共有シークレットのヘッダを要求する。
  なお Origin ヘッダでの制限は curl などからは簡単に詐称できるので、対策にはならない。
