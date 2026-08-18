# DSH Lifeboat

[English](README.md) | 简体中文

DSH Lifeboat 是 DeepSeek Harness Profile 的进程外救援控制台。即使某个插件导致 Harness 无法启动，它仍能独立打开。所有探测都使用临时 `DSH_HOME`；只有用户明确确认恢复后，才会修改原 Profile 的 manifest。

![DSH Lifeboat 救援控制台](screenshot.png)

## 已实现

- 仅监听 `127.0.0.1` 的独立 Web 界面：展示探测进度、最小故障集合、证据、报告下载、恢复和撤销。
- 无界面的 CLI 诊断，输出相同的 `dsh-lifeboat/v1` JSON 报告。
- 默认通过 `dsh --profile <name> --dump-config` 做确定性的配置探测。
- 可选启动探测：进程正常退出或存活超过健康窗口即视为启动成功。
- 每次探测都创建全新的临时 Home；启动探测默认重复确认两次，证据不一致时不开放恢复。
- 对第三方 Bundle 执行 delta debugging，可定位单插件故障以及多个插件共同触发的冲突。
- 分别检查 Profile 自身和 Harness Home 的 `cordis.patch.yml`。
- 恢复前校验 manifest SHA-256、创建时间戳备份并原子写入；同一服务会话内可撤销。
- 有界单任务队列、可控关停、`GET /api/health`、页面刷新续接，以及原子持久化诊断报告。
- Harness 内部只加载一个健康标记插件；救援服务本身始终在 Harness 进程外。

## 从当前目录运行

要求 Node.js `^22.19.0 || >=24.0.0`，没有运行时依赖。

```sh
node ./src/cli.js serve
```

打开终端输出的 `http://127.0.0.1:<端口>/`。默认端口是 `4317`，可用 `--port 0` 自动选择空闲端口。

终态报告默认保存到 `$DSH_HOME/lifeboat/reports`。systemd 与 Windows 任务计划程序的托管方法见[服务运行说明](docs/service.md)。

只使用 CLI：

```sh
node ./src/cli.js diagnose --profile web
node ./src/cli.js diagnose --profile web --json
```

从 Harness 源码目录运行 `dsh` 时，不拼接 Shell 字符串，而是分别传入可执行文件和参数：

```sh
node ./src/cli.js diagnose \
  --command pnpm \
  --command-arg --dir \
  --command-arg /path/to/deepseek-harness \
  --command-arg dsh \
  --profile web
```

启动探测会真正执行已安装的插件代码，因此还需要明确确认：

```sh
node ./src/cli.js diagnose \
  --profile web \
  --mode boot \
  --boot-confirmations 2 \
  --allow-runtime-code-execution
```

## 作为 Harness Bundle 安装

在包含本目录的父目录执行：

```sh
dsh plugin --profile web add ./dsh-lifeboat
```

安装后，`cordis.patch.yml` 会把健康标记加入 Profile。救援界面不会挂在 Harness Web 内部，否则启动崩溃时它也无法使用。可从 Profile 的包环境启动：

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-lifeboat serve
```

## 自动隔离过程

1. 读取 `$DSH_HOME/profiles/<name>/package.json` 并记录 SHA-256。
2. 固定安装自带 Bundle；同时出现在 Profile `dependencies` 和活动 Bundle 列表中的包作为第三方候选。
3. 每次探测尝试都在系统临时目录创建新的 `dsh-lifeboat-*` Home。
4. 复制有限大小的普通 Profile 资源；跳过凭据文件和符号链接，并将 pnpm 相对包链接解析成绝对的包解析入口。
5. 先探测完整组合，再区分 Bundle 故障与用户 Patch 故障。
6. Bundle 故障通过子集和补集探测缩减成 1-minimal 故障集合。
7. 启动探测的重复结果不一致时，结论为 `unstable-probe`，不会生成自动恢复动作。
8. 默认先断开 Lifeboat 创建的包链接，再删除临时目录；选择“保留取证目录”时不删除。

“最小复现集合”不等于责任判定。若结果含两个 Bundle，只说明该组合在本次环境与探测方式下失败，不能证明其中任意一个单独有缺陷。

## 恢复行为

只有报告明确包含 Bundle 结论时，界面才会开放“应用恢复”：

1. 重新读取 manifest；若诊断后的文件 Hash 已变化则拒绝写入。
2. 将原文件保存到 `.lifeboat-backups/`。
3. 只从 `dsh.profile.bundles` 移除诊断出的最小集合，并原子替换 manifest。
4. 保留已安装依赖，便于排查和撤销。

之后执行 `dsh plugin` 包管理命令时，Harness 可能根据已安装依赖重新激活 Bundle。恢复启动后仍应更新或移除真正有问题的依赖。

## 安全边界

- 本地服务拒绝非回环 Host，使用严格 CSP，并要求随机的进程级写操作令牌。
- 配置探测不会挂载插件行。启动探测会以当前系统用户权限执行插件代码，它不是操作系统级插件沙箱。
- 子进程环境会移除名称含 `KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`CREDENTIAL`、`COOKIE` 或 `AUTH` 的变量。
- 启动存活窗口只是健康启发式，不代表应用功能已经全部验证。
- 当前版本面向采用 `dsh.profile.bundles` 的 Harness 预发布版本，尚未覆盖所有历史版本。

## 与 dsh-guard 的关系

Lifeboat 是独立实现，不是其他插件的分叉。当前目录中最接近的 [`dsh-guard`](https://github.com/x2802490130-prog/dsh-guard) 以滚动快照和进程内回退为主；它的 README 也明确说明进程内插件无法单独救援启动崩溃，需要外部启动器。Lifeboat 聚焦独立诊断服务、全新 Home 复现、最小冲突集合与证据门控恢复。详见[非排名式对照](docs/community-overlap.md)。

## 验证

```sh
npm test
npm run check
npm pack --dry-run --ignore-scripts
```

项目只使用 Node.js 内置模块，避免救援工具自己再引入一套可能损坏的依赖图。
