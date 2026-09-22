# Render免费私密试用部署

## 方案与限制

新建Render Free Web Service，不覆盖广告合规助手。`render.yaml`已设为`plan: free`、`TEMPLATE_PROVIDER=mock`和`FREE_DEMO_MODE=true`；免费模式强制Mock，不调用付费模型，无需设置DASHSCOPE_API_KEY。不创建磁盘、付费实例或付费数据库。

- 免费服务闲置会休眠，再次打开需要等待唤醒，不保证生产级持续在线。
- **休眠、重启、重新部署可能丢失SQLite及上传材料。** 固定URL不等于数据永久保留。
- 点击“备份与恢复”及时下载规则和报告。文件未加密，可能含候选信息，请保存在自己的安全设备上。
- 规则恢复为待审草案，需要重新检查发布；报告恢复为只读存档。恢复不覆盖现有数据。
- 历史校验失败规则保存在备份文件的`unrestorable_rules`附录，不自动恢复；请保留原始备份，需要时人工修正规则。恢复不认证报告内容真实性。
- **不是完整灾备**：不含原始附件、样本库、完整审计数据库，也不能恢复运行中的评估任务。原始资料必须另留副本。
- 只使用模拟或脱敏资料。共享账号适合受邀试用，所有人共享工作区，没有个人隔离权限，不要公开密码。
- Render免费时长、带宽和构建分钟有配额。若账号绑定支付方式，超额可能计费。部署前检查费用上限和用量设置；不要开启自动付费或升级。不能确认零费用时停止创建。

## 部署步骤

1. 在项目目录运行`npm.cmd run prepare:render`。将打印出的最新`deployment/render-source-...`目录内容上传**新的GitHub私有仓库**。仅用最新Free配置包，旧包可能仍含付费配置。
2. 脚本不打包本机数据库、上传材料、聊天记录、测试报告、`.env`或密钥。配置中可能有公开/模拟样本，上传前检查。不要上传整个工作区。
3. 在自己的浏览器登录GitHub和Render，不要向聊天发送密码或密钥。Render → New → Blueprint，选择新仓库。
4. 确认只有一个Free Web Service，没有Disk、数据库或其他付费资源；出现付费项则停止确认。
5. 在Render设置`APP_ACCESS_PASSWORD`，至少16位随机密码，不写源码。构建`npm ci --include=dev && npm run build`，启动`npm start`，健康检查`/api/health`。HOST为0.0.0.0，端口由Render注入。
6. 成功后使用Render实际分配的`https://<服务名>.onrender.com`，这里仅是地址格式，不是已经创建的地址。用户名`reviewer`，密码为配置的访问密码，仅给受邀试用者。

## 验收

- 未登录不能读取页面、规则、报告、备份或调用恢复接口。健康检查仅返回非敏感状态。
- 首页显示免费试用及数据丢失提醒，模型模式为Mock。
- 生成规则后在规则库找回；导出并恢复，规则状态为待检查草案；报告为只读存档。
- 重复恢复同一备份不重复新增；无效备份整体拒绝，不部分写入。
- 本机历史数据库不会自动上传云端，不要依靠一次刷新成功推断数据永久保存。

## 本机测试免费配置

```powershell
Set-Location -LiteralPath 'D:\候选人评估系统'
$env:FREE_DEMO_MODE = 'true'
npm.cmd run dev
```

本机默认不要求密码。如需模拟受保护部署，可在服务端设置APP_ACCESS_PASSWORD，不把真实密码写入可分享脚本。

参考：[Render免费限制](https://render.com/docs/free)、[Blueprint配置](https://render.com/docs/blueprint-spec)。
