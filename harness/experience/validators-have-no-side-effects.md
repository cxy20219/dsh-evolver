---
title: 校验器不许有副作用
summary: 校验器只能读：py_compile 会写 __pycache__，改用内存 compile 并排除构建产物
---
# 校验器不许有副作用

## 现象

给 `harness/validate.js` 加 Python 语法检查，用的是：

```js
await run('python3', ['-m', 'py_compile', path])
```

跑一次校验，项目的 `harness/scripts/` 下多出一个 `__pycache__/`，7 个 `.pyc`。
更糟的是**旧版 Python 校验器把 `.pyc` 当成资源**，于是下一次校验报出
「`harness/scripts/__pycache__/analyze_backtest.cpython-314.pyc` 没有文档引用」——
一个校验动作制造了自己下一轮要报的错。

## 根因

`py_compile` 的设计目的就是写出字节码；`-m` 调用不会跳过落盘。
校验器的契约是**只读**，用了会写的工具就等于违约。

## 做法

改成内存编译，只解析不落盘：

```js
await run('python3', [
  '-c',
  'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")',
  path,
], { timeout: 20_000 })
```

顺带在 `isNoise()` 里排除 `__pycache__`、`node_modules` 和点开头的一层，
让任何构建产物都进不了资源清单。

## 边界

- 内存编译只验证语法，不执行、不导入依赖；它抓不到「语法对但 import 缺失」。
- 需要真实运行验证的脚本，仍按脚本优先协议在 workflow 里写代表性命令。

## 验证

跑一次 `harness_validate`，然后确认项目里没有新增目录：

```bash
ls harness/tool/__pycache__ 2>/dev/null | wc -l   # 期望 0
```
