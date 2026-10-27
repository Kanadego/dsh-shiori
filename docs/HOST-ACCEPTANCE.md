# 真实宿主验收待办

本清单是**首次安装、公开 GitHub/npm 发布或宣称 DSH 宿主兼容之前**必须完成的隔离发布 smoke 闸门；不是继续合成功能开发的阻塞项。当前仅有合成数据与模拟 host 的 P0/P1 验收，清单未运行，也不允许自动改真实 profile。L2 Sparks 合成开发同样不得读取或写入用户真实资料。

## 隔离宿主先行

准备单独测试 profile、单独 data root 与可回退的配置备份，禁接真实记忆/人设。注入显式personaAdapter之前，soul_read可报告无卡、soul_update应UNSUPPORTED；不得拿真实卡做夹具。核对真实ctx.systemPrompt/tools注册与事件源，单一工具所有者冲突应阻止active启动。

## 出站与压缩矩阵

- 完整 system 每次由宿主assemble投影：L0+完整L1(正文和派生索引)不能只发简短替代system；provider路由变化后也一致。
- active写后下一次请求真实出站的完整L1必须更新；同步section模式刷新失败必须显式诊断，不能说缓存已生效。
- billion-context直接compress与PTC子调用两条实际完成事件，成功created blocks推进一次；失败、零块、无可证块数不推进；重放/重启保持去重。
- 工具写CAS与同operationId重试必须跨实际重启稳定，全局fallback写当前scope不改global。
- host capability不足时明确UNSUPPORTED；shadow零同名工具/零section/零记忆写入，退出后注册清理。

以上只读代码与mock不能代替真实出站抓取；首次涉及付费 provider 需由操作者确认计费并限定探针次数。

## 尚未实现的产品功能

L2 spark图谱选择与用户消息附件投递、沉降与整理任务、双轨遗忘、正式persona持久化adapter、安装与迁移流程。DESIGN是后续范围依据，不把config里的预算/卡片数量校验当成功能已实现。
