# 微信签到抽奖 Web 项目

本项目用于内网活动现场：电脑启动服务，大屏展示二维码，来宾用微信扫码签到，后台管理奖项并发起滚动抽奖。

## 启动

```bash
npm install
npm start
```

默认端口：`3000`

打开：

- 登录页：http://localhost:3000
- 后台：http://localhost:3000/admin
- 大屏：http://localhost:3000/screen
- 手机签到：http://localhost:3000/checkin

同一局域网手机访问时，用服务启动后打印的 `http://本机IP:3000` 地址。
如果电脑用 `localhost` 打开后台或大屏，系统会优先把签到二维码生成为局域网 IP 地址；也可以通过 `PUBLIC_URL=http://本机IP:3000 npm start` 手动指定。

## 默认密码

- 后台：`admin123`
- 大屏：`screen123`

登录状态保存在当前浏览器窗口，关闭浏览器后需要重新登录。

## 已实现能力

- 微信扫码签到入口，二维码默认使用局域网签到地址。
- 大屏二维码和 Logo 可拖动摆放，二维码支持拖动手柄或 `+` / `-` 按钮缩放，松手或点击后自动保存。
- 抽奖时头像墙滚动、高亮候选人，抽奖面板有闪动特效。
- 签到数据和中奖数据可导出 Excel。

## 项目目录

- `src/server.js`：后端服务、数据接口、实时同步、Excel 导出。
- `src/public/`：前端页面、大屏、后台、手机签到。
- `data/store.example.json`：初始数据模板。
- `data/store.json`：运行后自动生成的活动数据。
- `assets/uploads/`：后台上传的 Logo、音乐、奖品图片。
- `docs/requirements-summary.md`：需求整理。
- `docs/source-ppt/`：原始 PPT 和提取素材。

## 微信头像和昵称

扫码签到页已改为微信网页授权模式：配置完成后，来宾用微信扫码进入页面，会自动获取微信 `openid`、昵称和头像并完成签到，不需要填写姓名、单位、手机号。

启动前设置以下环境变量：

```bash
WECHAT_APP_ID=你的公众号AppID \
WECHAT_APP_SECRET=你的公众号AppSecret \
PUBLIC_URL=https://你的公网域名 \
npm start
```

要求：

- `PUBLIC_URL` 必须是微信能访问到的公网 HTTPS 域名。
- 在微信公众号后台配置“网页授权域名”，域名与 `PUBLIC_URL` 保持一致。
- 回调地址为：`PUBLIC_URL/wechat/oauth/callback`
- 默认授权范围为 `snsapi_userinfo`，用于获取头像和昵称。

没有配置这些环境变量时，签到页会提示“微信授权未配置”，不会再要求来宾填写表单。
