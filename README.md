# Aelion Studio

浏览器内的时间线剪辑器，只通过 [`@aelionsdk/sdk`](https://github.com/FoyonaCZY/AelionSDK) 与 `@aelionsdk/export` 的公开入口接入。

本仓库按嵌套开发来放：克隆到 AelionSDK 的 `apps/editor-demo`。SDK 仓库已经 gitignore 这个目录，方便两边一起改、互不提交。

```bash
cd /path/to/AelionSDK
git clone https://github.com/FoyonaCZY/AelionStudio.git apps/editor-demo
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm dev:editor
```

打开 `http://127.0.0.1:4174/`。
