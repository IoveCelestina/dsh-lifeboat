# DSH Lifeboat

[English](README.md) | 简体中文

DSH Lifeboat 是 DeepSeek Harness Profile 的进程外救援控制台。即使某个插件导致 Harness 无法启动，它仍能独立打开。所有探测都使用临时 `DSH_HOME`；只有用户明确确认恢复后，才会修改原 Profile 的 manifest。

![DSH Lifeboat 救援控制台](screenshot.png)

## 已实现

- 仅监听 `127.0.0.1` 的独立 Web 界面：展示探测进度、证据、已验证恢复方案选择、报告下载和一键撤销。
- 无界面的 CLI 诊断，输出相同的 `dsh-lifeboat/v1` JSON 报告。
- 默认通过 `dsh --profile <name> --dump-config` 做确定性的配置探测。
- 可选启动探测：进程正常退出或存活超过健康窗口即视为启动成功。
- 每次探测都创建全新的临时 Home；启动探测默认重复确认两次，证据不一致时不开放恢复。
- 对完整 Profile 执行有界删除集合搜索：浅层先证明全局最少删除数，再以经验证的 1-minimal 方案兜底。
- 分别检查 Profile 自身和 Harness Home 的 `cordis.patch.yml`。
- 恢复前校验 manifest SHA-256、创建时间戳备份并原子写入；服务重启后仍可撤销。
- 有界单任务队列、可控关停、`GET /api/health`、重启后找回报告与撤销凭据，以及原子持久化诊断报告。
- Harness 内部只加载一个健康标记插件；救援服务本身始终在 Harness 进程外。

## 从当前目录运行

要求 Node.js `^22.19.0 || >=24.0.0`，没有运行时依赖。

```sh
node ./src/cli.js serve
```

打开终端输出的 `http://127.0.0.1:<端口>/`。默认端口是 `4317`，可用 `--port 0` 自动选择空闲端口。

终态报告默认保存到 `$DSH_HOME/lifeboat/reports`，默认保留最新 500 份；可用 `--max-reports N` 调整。只有外部留存策略负责清理时才建议用 `--max-reports 0` 关闭自动清理。systemd 与 Windows 任务计划程序的托管方法见[服务运行说明](docs/service.md)。

只使用 CLI：

```sh
node ./src/cli.js diagnose --profile web
node ./src/cli.js diagnose --profile web --json
node ./src/cli.js diagnose --profile web --max-exact-removals 2 --max-recovery-probes 256
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

通过 Harness 安装固定版本的 v0.1.1 Release：

```sh
dsh plugin --profile web add https://github.com/IoveCelestina/dsh-lifeboat/releases/download/v0.1.1/dsh-lifeboat-0.1.1.tgz
```

如需安装本地检出，则在包含本目录的父目录执行：

```sh
dsh plugin --profile web add ./dsh-lifeboat
```

安装后，`cordis.patch.yml` 会把健康标记加入 Profile。救援界面不会挂在 Harness Web 内部，否则启动崩溃时它也无法使用。可从 Profile 的包环境启动：

```sh
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-lifeboat serve
```

Release 包通过 GitHub Release 资产分发，不发布到 npm Registry。在将它用于真实故障前，应当用当前 Harness CLI 再验证一次上面的 tarball 安装链路。

## 自动隔离过程

1. 读取 `$DSH_HOME/profiles/<name>/package.json` 并记录 SHA-256。
2. 固定安装自带 Bundle；同时出现在 Profile `dependencies` 和活动 Bundle 列表中的包作为第三方候选。
3. 每次探测尝试都在系统临时目录创建新的 `dsh-lifeboat-*` Home。
4. 复制有限大小的普通 Profile 资源；跳过凭据文件和符号链接，并将 pnpm 相对包链接解析成绝对的包解析入口。
5. 先探测完整组合，再区分 Bundle 故障与用户 Patch 故障。
6. Bundle 故障以“删除哪些 Bundle 后，完整的其余 Profile 能否通过”为判据。精确阶段从删除 1 个开始，按数量递增到配置深度；只要找到方案，所有更小删除数都已排除，因而它是全局最少删除数。
7. 精确阶段没找到方案时，delta debugging 会缩减“删除全部候选 Bundle”这个已知可恢复集合。兜底结果是 1-minimal：任意恢复其中一个 Bundle 都会失去当前恢复效果，但不保证没有更小的非局部方案。
8. 每个候选方案都会在另一个全新 Home 中，带上全部未删除 Bundle 和原 Patch 独立复验。复验失败、启动证据不稳定或搜索预算耗尽时，都不生成自动恢复。
9. 启动探测的重复结果不一致时，结论为 `unstable-probe`。
10. 默认先断开 Lifeboat 创建的包链接，再删除临时目录；选择“保留取证目录”时不删除。

搜索不会无界遍历 `2^n` 个组合。精确深度为 `k` 时，候选数上界为 `C(n,1) + ... + C(n,k)`，但精确与兜底阶段共享一个硬探测预算。默认精确深度是 2；配置探测预算是 256，启动探测是 64。可在界面的高级参数或 `--max-exact-removals` / `--max-recovery-probes` 中调整。

这些是恢复方案，不是责任判定。若 A 和 B 只在同时激活时失败，Lifeboat 可同时给出“停用 A”和“停用 B”两个等价方案；若 A 和 B 各自都会导致失败，经验证的方案就必须同时停用两者。报告会区分 `exact` 与 `one-minimal`，并记录是否已枚举全部同删除数的备选方案。

## 恢复行为

只有报告包含通过独立复验的 Bundle 删除方案时，界面才会开放“应用恢复”：

1. 用户在多个经验证的等价方案中选择一个。
2. 服务端从自己的诊断报告解析 `planId`，拒绝客户端自行拼出的 Bundle 列表。
3. 获取 Profile 级跨进程写锁，拒绝重叠的恢复操作。
4. 重新读取 manifest；若诊断后的文件 Hash 已变化则拒绝写入。
5. 拒绝链接形式的 Profile、manifest、锁或备份目录，再将原文件完整写入 `.lifeboat-backups/`，文件名记录完整 SHA-256。
6. 校验备份后原子替换 manifest，只从 `dsh.profile.bundles` 移除所选方案的 Bundle，并保留已安装依赖。
7. 持久化恢复凭据，使一键撤销在本地服务重启后仍可用；撤销前同时校验备份 Hash 和 manifest 结构，并把恢复后的 manifest 留作额外回退保护。

之后执行 `dsh plugin` 包管理命令时，Harness 可能根据已安装依赖重新激活 Bundle。恢复启动后仍应更新或移除真正有问题的依赖。

## 安全边界

- 本地服务拒绝非回环 Host，使用严格 CSP，并要求随机的进程级写操作令牌。
- 配置探测不会挂载插件行。启动探测会以当前系统用户权限执行插件代码，它不是操作系统级插件沙箱。
- 子进程环境会移除名称含 `KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`CREDENTIAL`、`COOKIE` 或 `AUTH` 的变量。
- 启动存活窗口只是健康启发式，不代表应用功能已经全部验证。
- 当前版本面向采用 `dsh.profile.bundles` 的 Harness 预发布版本，尚未覆盖所有历史版本。

## 与 dsh-guard 的关系

Lifeboat 是独立实现，不是其他插件的分叉。当前目录中最接近的 [`dsh-guard`](https://github.com/x2802490130-prog/dsh-guard) 以滚动快照和进程内回退为主；它的 README 也明确说明进程内插件无法单独救援启动崩溃，需要外部启动器。Lifeboat 聚焦独立诊断服务、全新 Home 复现、已验证的有界删除方案与证据门控恢复。详见[非排名式对照](docs/community-overlap.md)。

## 验证

```sh
npm test
npm run check
npm pack --dry-run --ignore-scripts
```

项目只使用 Node.js 内置模块，避免救援工具自己再引入一套可能损坏的依赖图。
