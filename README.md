# blog-to-sns

ブログ記事のURLを貼るだけで、X・Facebook・note用の投稿文とアイキャッチ画像を自動生成するダッシュボードです。

## セットアップ

👉 **[セットアップマニュアル（HTML）を開く](./manual.html)**

## 必要なもの

- Node.js 18以上
- Gemini API キー（無料で取得可能）
- 各SNSのAPIキー（自動投稿を使う場合のみ）

## クイックスタート

```bash
git clone https://github.com/akihiroshibue/blog-to-sns.git
cd blog-to-sns
npm install
npx playwright install chromium
node bridge-server.mjs &
open index.html
```

## 作者

渋江昭弘 / [@akihiroshibue](https://x.com/akihiroshibue)

AIを使った売上アップの仕組みを発信しています。
LINE公式で無料の設定ファイルを配布中：[リンクを追加]
