# favo-like-wp-basic — X (旧Twitter) の「いいね・RT・引用」自動保存ツール（1ポスト＝1記事版）

あなたの X（旧Twitter）の **「いいね (Likes)」「リポスト (RT)」「引用ポスト (Quotes)」** を定期的に自動取得し、**1ポスト＝1記事** としてご自身の **WordPress** ブログに全自動で保存していくツールです。

パソコンにソフトをインストールしたり、黒い画面（ターミナル）でコマンドを打つ必要は**一切ありません**。GitHub の画面上でボタンを押すだけで、Cloudflare の無料枠を使って24時間365日自動で動き続けます！

---

## ✨ できること

1. **「いいね」「RT」「引用」を1ポスト＝1記事としてWordPressへ自動保存**
   - いいねしたポスト、RTしたポスト、引用したポストをそれぞれ独立したWordPress記事（タイトル例：`[いいね] @user: 本文抜粋...`、`[RT] @user: ...`、`[引用] @user: ...`）として保存します。
   - 一度保存したポストは 고유スラッグ（`x-favo-like-ツイートID` 等）で管理されるため、同じポストが重複して記事になることはありません。
2. **画像・動画のリンク切れ（リンク死）完全対策**
   - ポストや引用・RT先に含まれる画像や動画（`.mp4`）を自動でダウンロードし、**あなたの WordPress のメディアライブラリにアップロードして保管**します。元ポストが削除されても画像・動画は消えません。
3. **レンタルサーバー（Xserver・ConoHa・ロリポップ等）にも完全対応**
   - WordPress REST API に加え、XML-RPC 自動フォールバックを搭載しているため、セキュリティ設定の厳しいレンタルサーバーでもエラーにならず保存できます。
4. **GitHub への Markdown 保存（任意・選択式）**
   - 希望する場合は、GitHub リポジトリ内にも Markdown ファイル（`FavoYear2026.md` / `FavoMonth202611.md` / `FavoFulldata.md`）を自動作成・更新できます。

---

## 🔑 事前に用意するもの

### ① WordPress の「アプリケーションパスワード」
1. 自分の WordPress 管理画面にログインし、左メニューの **「ユーザー」→「プロフィール」** を開きます。
2. 一番下にある **「アプリケーションパスワード」** の欄で、名前に `favo-like` と入力して **「新しいアプリケーションパスワードを追加」** を押します。
3. 表示された24桁のパスワード（`xxxx xxxx xxxx ...`）をメモします。

### ② X (Twitter) の API キー
1. [X Developer Portal](https://developer.x.com/en/portal/dashboard) で App の設定画面を開きます。
2. **「Settings」タブ →「User authentication settings」** で App permissions が **`Read`**（または Read and Write）になっていることを確認します。
3. **「Keys and tokens」** タブを開き、以下のキーを発行（Regenerate）してメモします：
   - **「いいね (Likes)」も取得する場合（推奨）**:
     - X API の仕様上、非公開化された「いいね一覧」を取得するには **Consumer Keys（`API Key` と `API Key Secret`）** と **Authentication Tokens の `Access Token and Secret`（`Access Token` と `Access Token Secret`）** の4つが必要です。
   - **「RT」と「引用」だけ取得する場合**:
     - **`Bearer Token`** 1つだけで動きます。

   Bearer Token と OAuth 1.0a の両方を設定している場合、公開 API（ユーザー・タイムライン・ポスト情報）は Bearer Token を先に使用し、401の場合は OAuth 1.0a へ自動で再試行します。「いいね」取得には OAuth 1.0a の4キーを使用します。X Developer Portal で API Key/Secret を再発行した場合は、対応する Access Token/Secret も再発行して4つを同じ App の組み合わせにしてください。

### ③ Cloudflare の「Account ID」と「APIトークン」
1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にログインし、左メニュー **「Workers & Pages」** の画面右側にある **「Account ID」** をメモします。
2. 右上の人型アイコン → **「My Profile」** → **「API Tokens」** → **「Create Token」** を開きます。
3. **「Edit Cloudflare Workers」** の **「Use template」** を押し、Account Resources に `All accounts`、Zone Resources に `All zones` を選んでトークンを作成し、メモします。

---

## 🚀 使い方（3ステップで完了！）

### ステップ1：このリポジトリを自分のGitHubにコピーする
1. このページ右上の **「Use this template」**（または **「Fork」**）ボタンを押して、自分のアカウントにリポジトリを作成します。

---

### ステップ2：GitHub に鍵（Secrets）を登録する
1. 自分のリポジトリ上部の **「Settings」** タブ → 左メニュー **「Secrets and variables」** → **「Actions」** を開きます。
2. 緑色の **「New repository secret」** ボタンを押して、以下の項目を登録します。

#### 【基本の必須項目】

| Name（名前：コピペしてください） | Secret（入力する内容） |
| :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare の APIトークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare の Account ID |
| `X_USERNAME` | あなたのXのID（`@`は付けない。例: `showya_kiss`） |
| `WP_URL` | あなたのWordPressのURL（例: `https://example.com`） |
| `WP_USERNAME` | WordPressのログイン用ユーザー名 |
| `WP_APP_PASSWORD` | 準備①で作ったWordPressのアプリケーションパスワード |

#### 【X API 認証キー（いいねも取るなら上の4つ、RT・引用だけならBearer Token）】

| Name（名前） | Secret（入力する内容） |
| :--- | :--- |
| `X_API_KEY` | X Developer Portal の Consumer Keys: **API Key**（「いいね」取得に必要） |
| `X_API_SECRET` | X Developer Portal の Consumer Keys: **API Key Secret**（「いいね」取得に必要） |
| `X_ACCESS_TOKEN` | X Developer Portal の **Access Token**（「いいね」取得に必要） |
| `X_ACCESS_SECRET` | X Developer Portal の **Access Token Secret**（「いいね」取得に必要） |
| `X_BEARER_TOKEN` | X Developer Portal の **Bearer Token**（上の4つを入れる場合は省略してもOK） |

#### 【任意：GitHub にも Markdown 保存したい人だけ追加】

| Name（名前） | Secret（入力する内容） |
| :--- | :--- |
| `GH_SYNC_TOKEN` | GitHub の Personal Access Token (`ghp_...`) |
| `GH_SYNC_REPO` | 保存先リポジトリ名（未登録ならこのリポジトリ自身に保存されます） |

---

### ステップ3：GitHub Actions を実行して自動稼働をスタートする
1. リポジトリ上部の **「Actions」** タブを開きます。
2. 左側の **「Deploy favo-like-wp to Cloudflare Workers」** をクリックします。
3. 右側の **「Run workflow」** を押し、実行間隔（`cron_minutes`：デフォルトは `1` 分おき）や取得対象（`include_likes`, `include_retweets`, `include_quotes`）を確認して緑色の **「Run workflow」** ボタンを押します。
4. 緑色のチェックマーク ✅ が付けば完了です！
