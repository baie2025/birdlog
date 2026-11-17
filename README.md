# BirdLog 观鸟记录

自用的观鸟照片记录应用。原图存在你自己的 Google Drive 里，应用按日期、地点、鸟种整理和浏览。电脑和手机都用浏览器打开，手机上可以「添加到主屏幕」当 App 用。

- 导入 JPEG、PNG、HEIC 和相机 RAW，原图原样保存，另外生成缩略图和预览图用来浏览
- 自动读出拍摄时间、相机参数和照片自带的位置
- 鸟种用 eBird 分类（2026 版，中英文名），可以用中文名、英文名、学名或四字母代码搜索
- 三个视图：时间线（按日期）、鸟种、地点，各自可以排序和筛选
- 同一天、同一地点、同一种鸟的照片自动算作一条记录，可以填数量和备注
- 已拍鸟种统计（算法和 eBird 生涯清单一致）、每种鸟的封面照片、按年份看新增
- 多台设备之间通过 Drive 里的记录文件同步
- 查重：同一个文件不会重复上传
- 导出记录表格（CSV）和数据备份（JSON）

## 现在的状态

在浏览器里验证过的：

- 「本地试用」模式下的完整流程：导入、标鸟种、设地点、上传、三个视图、看图器、批量操作、删除、深浅色、手机和电脑两种布局
- Drive 存储和同步的逻辑，跑在一个**模拟的** Drive 上（`test/drive-test.html`，18 项全部通过）

- 真实的 Google Drive、真实的 PNG 和相机 RAW 上传：2026-11-16 由使用者本人测过，没有问题

还没有验证的：

- **真实的 HEIC 照片**
- **手机键盘弹出时对话框的位置**：iPhone 上曾把输入框顶出屏幕，已改成对话框只占键盘上方的可见区域，这个修改还没在真机上确认

## 在电脑上打开

需要 Node（这台电脑上在 `D:\Node`）。

```bash
node tools/serve.js
```

然后在浏览器里打开 <http://localhost:5173>。没有填 Google 凭证时，只能用「先在本地试用」。

## 第一步：创建 Google 凭证（约 10 分钟，只做一次）

应用要读写你的 Drive，需要一个「OAuth 客户端 ID」告诉 Google 是哪个应用在请求授权。这个 ID 不是密码，可以公开。

1. 打开 <https://console.cloud.google.com/>，用你存照片的那个 Google 账号登录。
2. 顶部的项目选择框 → **New Project**，名字随意（比如 `BirdLog`），创建后选中它。
3. 启用 Drive 接口：打开 <https://console.cloud.google.com/flows/enableapi?apiid=drive.googleapis.com>，确认项目是刚建的那个，点 **Enable**。
4. 左上角菜单 → **Google Auth platform** → **Branding**，点 **Get Started**：
   - **App name** 填 `BirdLog`，**User support email** 选你的邮箱
   - **Audience** 选 **External**（Internal 只有公司或学校的 Workspace 账号才能选）
   - **Contact Information** 填你的邮箱，同意条款，点 **Create**
5. 左侧 **Audience** → **Test users** → **Add users**，把你自己的 Gmail 地址加进去。
6. 左侧 **Clients** → **Create Client**：
   - **Application type** 选 **Web application**，名字随意
   - **Authorized JavaScript origins** 里加两条（第二条等 GitHub Pages 的地址确定后再加也行）：
     - `http://localhost:5173`
     - `https://你的GitHub用户名.github.io`
   - 点 **Create**，复制得到的 **Client ID**（形如 `1234567890-xxxx.apps.googleusercontent.com`）
7. 用记事本打开项目里的 `config.js`，把 Client ID 粘到 `googleClientId: ''` 的引号里，保存。

刷新 <http://localhost:5173>，「连接 Google Drive」按钮就能用了。授权窗口里会显示应用申请的权限：只能访问它自己创建的文件。

两点说明：

- 应用处在 **Testing** 状态时，Google 可能每 7 天要求重新同意一次授权。如果觉得烦，可以在 **Audience** 页点 **Publish app** 改成正式状态。BirdLog 只用了 `drive.file` 这一个非敏感权限，按 Google 的规则不需要审核。这一点我没有在你的账号上实际验证过。
- 浏览器里的授权大约一小时过期，过期后页面顶部会出现「连接 Google Drive」，点一下即可，一般不用再输密码。

## 第二步：放到 GitHub Pages（让手机也能打开）

手机访问需要一个 HTTPS 网址。GitHub Pages 免费，但免费账号要求仓库是**公开**的：代码会公开，照片和记录不在仓库里，不会公开。

1. 在 GitHub 上新建一个公开仓库，比如叫 `birdlog`（不要勾选自动生成 README）。
2. 在项目文件夹里运行：

   ```bash
   git init -b main
   git add .
   git commit -m "BirdLog"
   git remote add origin https://github.com/你的用户名/birdlog.git
   git push -u origin main
   ```

3. 仓库页面 → **Settings** → **Pages** → **Build and deployment**：Source 选 **Deploy from a branch**，Branch 选 **main** 和 **/ (root)**，保存。
4. 等一两分钟，网址是 `https://你的用户名.github.io/birdlog/`。
5. 回到第一步的第 6 条，确认 **Authorized JavaScript origins** 里有 `https://你的用户名.github.io`（只写到 `.io`，后面不带路径）。

手机上用浏览器打开这个网址，连接同一个 Google 账号，就能看到电脑上导入的记录。iPhone 在 Safari 里点「分享 → 添加到主屏幕」，安卓在 Chrome 菜单里点「添加到主屏幕」。

以后改了代码，`git add . && git commit -m "..." && git push` 就会自动更新。

## 日常使用

- **导入**：把照片拖进窗口，或点「导入照片」选择。先在「待导入」区给当天的照片设地点、多选后标鸟种，再点「开始上传」。鸟种和地点也可以上传之后再标。上传在后台进行，期间不要关掉页面。
- **相机 RAW**：三种方式都支持。导出 JPEG 最省空间，拍摄信息最完整；PNG 体积大，而且有些软件导出时会丢掉拍摄时间；直接传 RAW 时，应用用 RAW 里内嵌的预览图来显示，看到的是未裁剪、未调色的画面。
- **拍摄时间**：读不到时会用文件的修改时间并提示，可以在看图器里改。
- **删除**：原图会移到 Drive 的回收站，30 天内可以在 Drive 里恢复。
- **搜索鸟种**：英文名可以只打每个词的开头（`red tai haw`），也可以用四字母代码（`RTHA`）。用过和拍过的鸟种会排在前面。

## Drive 里存了什么

```
BirdLog/
  birdlog.json                        所有记录
  Photos/2026/2026-11-14 地点名/…      原图，文件名和内容都不变
  _app/thumbs/、_app/previews/        缩略图和预览图
```

- 文件夹名里的地点是**上传时**设的地点；之后在应用里改地点，文件不会跟着挪位置，以应用里的记录为准。
- `birdlog.json` 每次保存 Drive 都会留历史版本，误操作后可以在 Drive 里右键「管理版本」找回。
- 不要在 Drive 里直接改名、移动或删除 `BirdLog` 里面的文件，否则应用会找不到对应的照片。整个 `BirdLog` 文件夹可以挪位置。

## 维护

- **更新鸟种名录**：eBird 每年十月左右更新分类。运行 `node tools/build-taxonomy.js` 会重新下载并生成 `data/taxonomy.json`。
- **自测**：
  - `node test/node-test.mjs`：RAW 解析、鸟种搜索等
  - `node tools/serve.js 5174`，然后打开 <http://localhost:5174/test/drive-test.html>：Drive 存储和同步逻辑（模拟的 Drive）。请用 5174 端口，避免和正式数据共用浏览器存储。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| `index.html`、`css/app.css` | 页面和样式 |
| `config.js` | Google 客户端 ID |
| `js/main.js` | 启动、页面切换、整体框架 |
| `js/store.js` | 数据、修改、同步、缩略图读取 |
| `js/backend-drive.js`、`js/backend-local.js` | Google Drive 存储、本地试用存储 |
| `js/importer.js`、`js/imaging.js`、`js/rawfile.js` | 导入流程、图片处理、RAW 解析 |
| `js/taxonomy.js` | 鸟种名录和搜索 |
| `js/views.js`、`js/viewer.js`、`js/import-view.js`、`js/ui.js` | 界面 |
| `sw.js` | 离线时也能打开应用 |
| `tools/` | 本地预览服务器、名录下载脚本 |
| `test/` | 自测 |

没有构建步骤，改完文件刷新页面就能看到效果。

## 用到的第三方内容

- 鸟种名录：eBird/Clements Checklist，来自 Cornell Lab of Ornithology（通过 eBird 的公开接口下载）
- [htm](https://github.com/developit/htm) 和 Preact（Apache-2.0 / MIT）：界面
- [exifr](https://github.com/MikeKovarik/exifr)（MIT）：读拍摄信息
- [heic-to](https://github.com/hoppergee/heic-to)（LGPL-3.0，见 `vendor/heic-to.LICENSE.txt`）：解码 HEIC
