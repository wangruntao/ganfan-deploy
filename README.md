# 干饭盘 PC 管理后台（ganfan）

运营后台前端静态站点，容器化部署。

## 部署

```bash
docker build -t ganfan-admin .
docker run -d --name ganfan-admin -p 8105:80 ganfan-admin
```

- 容器内监听 **80**，宿主机映射 **8105**（即公司分配的端口）
- 纯静态站点，无需数据库、无需构建步骤
- 前端调用微信云开发 HTTP 网关（`app.js` 中 `API_BASE`），服务端 CORS 已全放行，任意域名/端口托管均可

## 版本来源

| 仓库版本 | 本仓库对应 commit |
|---|---|
| github.com/wangruntao/today-eat @ `ab2aa85` | 首次推送 |

源码主仓库：`https://github.com/wangruntao/today-eat`（`web/` 目录），后续更新以主仓库 commit 号为准。

## 依赖事项（部署同事）

后台的 API 走云开发 HTTP 访问服务，需要在**云开发控制台**（环境 `today-eat-d1g9okcsi57960feb`）建一条路由：

- 路径 `/api` → 云函数 `adminApi`，鉴权**关**

建好后可用下面的命令验证网关（返回 401 JSON 即为通）：

```bash
curl -s -X POST "https://today-eat-d1g9okcsi57960feb-1529065185.ap-shanghai.app.tcloudbase.com/api" \
  -H "content-type: application/json" -d '{"action":"ping"}'
```

路由就绪后，浏览器打开 `http://<测试服IP>:8105`，用 `admin` 账号登录即可。

## 更新流程

主仓库 `web/` 目录有改动时：

```bash
git pull   # 或由我们推送新 commit 到本仓库
docker build -t ganfan-admin . && docker rm -f ganfan-admin && docker run -d --name ganfan-admin -p 8105:80 ganfan-admin
```
