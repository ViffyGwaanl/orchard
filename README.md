<p align="center"><img src="assets/icon-256.png" width="128" alt="Orchard"></p>

<h1 align="center">Orchard 果园</h1>

<p align="center">让 Claude 直接打理你 Mac 上的提醒事项、日历、备忘录、邮件、信息和通讯录。<br>原生、快速、全部在本机运行。</p>

---

## 它能做什么

在 Claude 桌面应用里装好 Orchard 之后，你可以像对助理说话一样提要求。比如一句话加三条待办并各自设好提前两天的提醒，问它今天有哪些会、哪些事已经过期、收件箱里有哪些没读的邮件、谁的信息还没回，也可以让它把会议纪要写进备忘录的某个文件夹，替你起草一封回信放进邮件草稿箱，或者在你确认之后给家人发一条 iMessage。

早上打开 Claude 说一句帮我规划今天，它会一次性看完日历、到期和逾期的提醒、未读邮件和未读信息，再给你排一个现实可行的计划。

Orchard 共有 34 个工具，覆盖六个应用的读和写。

| 应用 | 能做的事 |
|---|---|
| 提醒事项 | 按今天、逾期、本周、无日期等时间窗口查找，批量新建，修改，完成，删除，管理列表；支持多个提醒时间（例如提前两天加提前一小时）、优先级、备注、链接和重复规则 |
| 日历 | 按日期范围和关键字查找，新建、修改、删除日程，支持全天事件、提醒、重复事件的单次或之后全部修改 |
| 通讯录 | 按中文或英文名字、昵称、公司、电话、邮箱查人 |
| 备忘录 | 列出文件夹和最近的备忘录，全文搜索，以 Markdown 读取，用 Markdown 新建、追加、替换、移动、删除 |
| 邮件 | 列出账户和邮箱，跨所有邮箱秒级搜索并带摘要预览，读取正文，起草和回复（默认放进草稿窗口给你过目），标记已读、旗标、移动、移到废纸篓 |
| 信息 | 列出会话和未读数，按人读取聊天记录，全局搜索，向个人或群聊发送文字和文件 |

另外还有一个今日概览工具和三个设置工具，后者负责检查权限、弹出系统授权对话框、打开对应的系统设置页面。

## 和原版 Apple MCP 有什么不同

Orchard 在 supermemoryai/apple-mcp 的基础上重写，同时吸收了另外几个开源项目的做法。

提醒事项和日历不再通过 AppleScript 操作应用界面，而是由一个原生的 Swift 小助手直接调用苹果的 EventKit 框架，速度快几十倍，也能做到 AppleScript 做不到的事，比如多个提前提醒、相对提醒、重复规则、按完成时间查询。这个思路参考了 FradSer/mcp-server-apple-events 和 krishna-desiraju/apple-reminders-swift-mcp-server。

小助手以自己的身份申请系统权限，所以授权对话框里显示的是 Orchard Helper，系统设置里也能单独开关。这个关键技巧来自 high5-ventures/apple-reminders-for-claude。没有这一步，Claude 桌面应用发出的提醒事项请求会被系统直接拒绝，连授权窗口都不会出现。

邮件和信息的读取直接查询 Mail 和信息自己的本地索引数据库，几万封邮件也能瞬间搜完，还能拿到每封邮件的摘要。信息里新版 macOS 存成二进制的消息正文，小助手会自己解码。这部分参考了 krmj22/macos-mcp。

原版缺少的修改、完成、删除操作全部补齐，备忘录支持 Markdown 双向转换，发信和发消息有安全设计，来自邮件、信息和备忘录的外部内容都会被标记成不可信数据，防止有人在邮件里藏指令操纵 Claude。

小助手常驻后台，提醒事项、通讯录和数据库连接一直保持热状态，连续操作不用每次重新启动进程。

## 安装

你需要一台装了 macOS 13 或更新系统的 Mac，以及 Claude 桌面应用。

第一步，双击 orchard-1.0.0.mcpb，Claude 桌面应用会弹出安装界面，点安装即可。

第二步，Orchard 第一次启动时会在你的 Mac 上编译那个 Swift 小助手，大约需要半分钟到一分钟。如果这台 Mac 从来没装过苹果的命令行开发工具，系统会弹窗请你安装，点安装后等几分钟，然后在 Claude 里说一句检查一下 Orchard 的状态。

第三步，在 Claude 里说帮我完成 Orchard 的权限设置。Claude 会调用状态检查工具，然后逐个触发系统授权对话框，你只要在弹出的窗口里点允许。

第四步（可选但推荐），读取信息聊天记录和极速邮件搜索需要完全磁盘访问权限，这个权限 macOS 不允许程序自己弹窗申请。Claude 会帮你打开系统设置的完全磁盘访问页面，同时在访达里选中 orchard-helper 这个文件，你把它拖进列表并打开开关就好。不开这个权限，邮件搜索仍然可用，只是会改成直接询问 Mail 应用，速度慢一些，范围也只限收件箱。

小助手编译后保存在 ~/Library/Application Support/Orchard/bin/orchard-helper。以后升级 Orchard 时，只要 Swift 源码没变就不会重新编译，已经给过的授权也会保留。

### 在 Claude Code 或其他客户端里使用

先在源码目录运行 npm install 和 npm run build，然后用下面的命令添加：

```bash
claude mcp add orchard -- node /path/to/orchard/dist/index.js
```

其他支持 MCP 的客户端，按 stdio 方式运行 node dist/index.js 即可。

## 设置项

安装界面里有一个开关，允许发送信息和邮件，默认打开。关掉以后，Claude 只能把邮件放进草稿窗口等你自己点发送，也不能发 iMessage。

## 安全和隐私

所有数据都留在你的 Mac 上。Orchard 本身不联网，不收集任何数据，Claude 只会看到你让它查询的那部分内容。

发信息和发邮件之前，Claude 会先把收件人和正文给你确认。邮件默认只是打开一个写好的草稿窗口，真正的发送按钮由你来按。删除提醒事项、备忘录、日程之类的操作，Claude 也会先征得同意，备忘录删除后进入最近删除，30 天内可以恢复。

为了能单独申请权限，小助手是一个以自己身份运行的程序。这意味着你给它的授权属于它本身，而不是 Claude 桌面应用。它只接受 Orchard 服务器通过标准输入发来的请求，不开放任何网络端口。如果哪天不再使用，在系统设置的隐私与安全性里关掉 Orchard Helper 的各项开关，再删除上面那个目录即可。

## 开发

```bash
npm install
npm run typecheck   # TypeScript 类型检查
npm test            # 日期、提醒时间、Markdown 转换的单元测试
npm run build       # 打包服务器
npm run smoke       # 用模拟的小助手端到端调用全部工具
npm run pack        # 生成 out/orchard-<版本>.mcpb
```

端到端测试里的模拟小助手会在 Node 里仿造 JXA 的对象模型，真实运行备忘录和邮件的自动化脚本，所以这些脚本的逻辑在没有 Mac 的环境里也能验证。设置 FAKE_FDA=0 可以模拟没有完全磁盘访问权限的情况。

代码结构如下。swift/OrchardHelper.swift 是原生小助手，负责 EventKit、通讯录、两个本地数据库和执行自动化脚本。src/helper 负责在本机编译小助手并维持和它的长连接。src/tools 是各个应用的 MCP 工具，src/jxa 是备忘录、邮件、信息的自动化脚本，src/lib 是日期解析和 Markdown 转换。

## 致谢

Orchard 以 MIT 许可证发布，站在这些开源项目的肩膀上，supermemoryai/apple-mcp、FradSer/mcp-server-apple-events、high5-ventures/apple-reminders-for-claude、krishna-desiraju/apple-reminders-swift-mcp-server、krmj22/macos-mcp。
