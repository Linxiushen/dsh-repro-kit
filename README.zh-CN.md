# dsh-repro-kit

[![CI](https://github.com/Linxiushen/dsh-repro-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Linxiushen/dsh-repro-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-repro-kit.svg)](https://www.npmjs.com/package/dsh-repro-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 DeepSeek Harness session export 转成确定性、因果切片、降低隐私泄漏风险、
适合附到 GitHub Issue 的最小复现包。

[English](README.md)

## 解决什么问题

DeepSeek Harness 官方导出强调无损，会包含根会话、导出的全部 subagent 后代和引用
附件。这很适合备份，却往往不适合直接公开。

`dsh-repro-kit` 保留排障结构，同时缩小披露面：

- 按最后一次错误、精确 seq 或 tool call 定位故障；
- 保留完整目标 turn、递归 `sourceEventSeqs`、工具调用/结果配对、request 状态和
  可用的父会话 lineage；
- 将 session、call、run、message、attachment ID 替换为 bundle 内稳定别名；
- 默认删除 prompt、system、reasoning、工具参数/结果、opaque metadata、路径、
  常见凭证以及所有附件字节；
- 输出确定性 ZIP、Markdown 时间线、版本化 manifest 和 payload SHA-256；
- 校验 ZIP 安全、哈希、连续 seq、跨文件关系和官方 Harness surface invariant。

## 快速开始

需要 Node.js 22.19+ 或 Node.js 24。

```console
pnpm dlx dsh-repro-kit inspect dsh-session-abc.zip
pnpm dlx dsh-repro-kit slice dsh-session-abc.zip --last-error
pnpm dlx dsh-repro-kit verify dsh-session-abc.repro.zip
```

也可以精确选择事件或工具调用：

```console
dsh-repro slice export.zip --seq 183 --session child-session-id
dsh-repro slice export.zip --tool-call call_01JXYZ -o issue-421.repro.zip
```

所有命令都支持 `--json`。默认拒绝覆盖已有输出，只有显式传入 `--force` 才覆盖。

## 处理链路

```mermaid
flowchart LR
  A["官方 ZIP / JSONL"] --> B["有界安全解析"]
  B --> C["目标定位"]
  C --> D["因果闭包"]
  D --> E["share-safe 脱敏"]
  E --> F["确定性 bundle"]
  F --> G["独立校验"]
```

输出结构固定：

```text
failure.repro.zip
├── manifest.json
├── REPORT.md
└── sessions/
    ├── session-001.jsonl
    └── session-002.jsonl
```

`manifest.json` 校验除自身以外的所有 payload，避免自引用哈希。bundle 不写入原始
export 的无盐摘要，防止外部确认对低熵原文的猜测。

## 因果切片

v1 策略名为 `enclosing-turn+causal-sources+tool-pairs+lineage`：

1. 将 selector 解析为唯一目标事件。
2. 存在 enclosing turn 时保留整个 turn。
3. 递归保留 source event、command/compaction 序号引用和 surface replacement 端点。
4. 保留同 turn/step 的 assistant tool block、`tool/call` 和 `tool/result`。
5. 补齐 turn/step 边界和最近适用的 request header/context。
6. 将 export 内可用祖先加入为只有 header 的 lineage session。
7. 连续重编号，并重写 provenance、replacement 引用和 `seedLength`。

manifest 会保留输出 seq 到原始 seq 的映射，方便回到本地原始日志排查。
同一 session 内，`--last-error` 以日志 seq 而不是 wall clock 为准。不同 session
之间不存在严格的因果总序，因此用 epoch 时间排序各自最后的故障，再以稳定存储
身份处理同时间戳并列。

## 安全边界

解压前会检查 ZIP 元数据，并拒绝路径穿越、反斜杠、重复 entry、重复 session ID、
无效 UTF-8、重复 JSON member、不支持的 session 版本、seq 间断以及超过固定字节、
entry、session 或行数预算的输入。packed chunk 使用公开的
`@deepseek-ai/dsh-session` decoder 展开。

默认脱敏保留事件类型、turn/step、provider/model、tool name、错误名/错误码、数字
usage 和相对时间。正文替换为稳定占位符，仅保留“是否相同”和字符长度关系；真实
时间戳归一化到 session 起点。

自动脱敏只能降低泄漏风险，不能保证所有插件自定义字段或敏感数字都无害。公开前
仍应人工检查 bundle。详细威胁模型见 [SECURITY.md](SECURITY.md)。

## Library API

```ts
import { buildBundle, loadExport, redactSlice, sliceExport, verifyBundle } from 'dsh-repro-kit'
import { writeFile } from 'node:fs/promises'

const source = await loadExport('dsh-session-abc.zip')
const slice = sliceExport(source, { kind: 'last-error' })
const artifact = buildBundle(redactSlice(slice))

await writeFile('failure.repro.zip', artifact.bytes)
await verifyBundle(artifact.bytes)
```

`redactSlice()` 返回的 `RedactedSlice` 不保留已加载的原始 export、selector 原值、
source path 或输入 digest；但按照上面的威胁模型，保留的诊断元数据仍需人工检查。

公开 TypeScript 类型包括 `InputLimits`、`SliceTarget`、`RedactedSlice`、
`BundleManifest` 和 `VerifyResult`；预期失败使用带稳定错误码的 `ReproError`。

## 退出码

| 退出码 | 含义 |
| ---: | --- |
| 0 | 成功 |
| 2 | 命令或参数错误 |
| 3 | 输入、格式或输出路径错误 |
| 4 | 切片目标不存在或不唯一 |
| 5 | bundle 无效或完整性校验失败 |

## 兼容性

v0.1 面向 DeepSeek Harness session format `0` 和
`@deepseek-ai/dsh-session@0.1.0-rc.7`。遇到未来格式版本会直接拒绝，不做可能生成
错误证据的 best-effort 转换。

格式说明见 [docs/FORMAT.md](docs/FORMAT.md)，manifest JSON Schema 见
[schemas/manifest.schema.json](schemas/manifest.schema.json)。

## 开发

```console
pnpm install --frozen-lockfile
pnpm check
```

MIT License。
