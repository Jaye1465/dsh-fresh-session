# dsh-fresh-session

A DSH (DeepSeek Harness) Web/Desktop plugin that makes **New Session** create a genuinely fresh Session instead of silently reusing a blank shell.

> Status: experimental, published as-is. It wraps private client services, so a DSH upgrade can break it. No maintenance commitment — issues and pull requests may sit for a while.

## The problem

DSH's Web client reuses the first "blank" Session of the Workspace when you click New Session (and when it restores the saved selection after a restart). That reused Session keeps the state recorded when it was **created**:

- its `subagent/model-selection-policy` (the routes subagents may use), and
- its Agent preset composition (the tool set composed from the preset definition at that time).

Neither is refreshed by upgrading DSH, editing the allowlist, or restarting the app. The result: a "new" conversation silently runs with an old tool set and an old model allowlist — for example, routes you added after the Session was created are rejected with `child LLM route "…" is not allowed for this Session`, and the UI gives no hint.

This is reported upstream, with a source-level explanation and a proposed Host-side fix: [deepseek-ai/deepseek-harness#13266 (comment)](https://github.com/deepseek-ai/deepseek-harness/discussions/13266#discussioncomment-19624807).

## What this plugin does

- Intercepts `uiWorkspace.createNamed` (the single choke point every blank reuse goes through). A request that names a `sessionId` is re-created without it, so the Host composes the **current** preset definition and records the **current** allowlist.
- Intercepts `uiWorkspace.restoreBlank` (startup restore of a saved blank) and creates a fresh Session instead, for the same reason.
- Never inherits the preset id recorded in the old Session: only a preset the caller explicitly passes **for this request** is forwarded; otherwise the configured default applies.
- Carries the unsent draft over: `localStorage['dsh.conversation.<oldId>']` is copied to the new Session id, but only when it contains non-empty text.
- Archives the replaced blank (after navigation settles) so it leaves the reusable pool; DSH has no Session-delete API.
- Degrades safely: if creation fails, it falls back to the original reuse request so you can still send. Disabling/removing the plugin unloads the wrappers and restores stock behavior.

## Install

Requires DSH `0.2.2-rc.3` (the client internals it wraps may change in later releases).

1. Clone or download this repository.
2. In DSH, open **Plugins → Add plugin** and select the cloned directory, or run the equivalent `plugin_manager` install with the directory as the target.
3. Reload the Web page (a newly installed client bundle needs one reload to load).

Then click New Session: you should land in a genuinely new Session, and the previous blank should move to the archived list.

Uninstall: remove the `dsh-fresh-session` bundle from Plugins (or `remove_bundle`). Stock behavior returns immediately.

## Known limits

- Web/Desktop client only. Remote, ACP and SDK clients call the Host directly and are unaffected.
- Sessions that already started are not repaired; start a new one.
- Draft attachments are not migrated (they are not part of `dsh.conversation.<id>`).
- A preset picked on the blank's preset chip is not carried to the *next* New Session; the next Session starts from the configured default. This is intentional: no state recorded in an old Session should decide what a new one can do.
- It relies on private client methods (`createNamed`, `restoreBlank`) and the private `mainReference` field. A DSH upgrade may rename them; the plugin then logs and leaves navigation untouched.

## Verification

Checked on DSH `0.2.2-rc.3` (Windows Desktop):

- New Session while a blank exists → new Session id, old blank archived, new log records the current allowlist.
- Full app restart while a blank is selected → the restore path also creates a new Session (the wrapper is installed before startup restoration runs).
- Non-empty draft → copied to the new Session (byte-identical localStorage value), old blank archived.
- New Session's log header records the current default preset and `isSeeded: false`; its `subagent/model-selection-policy` event carries exactly the routes configured at creation time.

## 中文说明

DSH 的「新会话」会复用工作区里的空白会话，而被复用的会话保留**创建时**的 preset 装配和 `subagent/model-selection-policy`。升级 DSH、修改模型白名单、甚至重启应用都不会刷新它们，于是「新会话」可能带着旧工具集和旧白名单运行，报 `child LLM route … is not allowed for this Session`，界面上也看不出来。

本插件把这条路径改成真正新建：拦截 `uiWorkspace.createNamed` / `restoreBlank`，不带旧 `sessionId` 创建，不继承旧会话记录的 preset，只把非空草稿带过去，并把被替换的旧空白归档。

安装：**Plugins → 添加插件** 选择本仓库目录，然后刷新页面。仅支持 Web/Desktop 客户端，依赖客户端内部方法，DSH 升级后可能需要重新验证。上游修复建议见 [讨论 #13266](https://github.com/deepseek-ai/deepseek-harness/discussions/13266#discussioncomment-19624807)。

## License

MIT
