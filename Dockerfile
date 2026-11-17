# 干饭盘 PC 管理后台
FROM nginx:1.27-alpine

# 静态文件（仓库根目录即站点根目录）
COPY index.html app.css app.js /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

# nginx 配置：SPA 静态服务 + 不缓存 html（发版即生效）
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
