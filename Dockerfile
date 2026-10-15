FROM node:20-alpine

WORKDIR /app

# 复制项目代码与账号配置
COPY package.json ./
COPY src/ ./src/
COPY data/ ./data/
COPY public/ ./public/

# 确保 data 目录及其子目录权限正常可写
RUN mkdir -p data/accounts && chmod -R 777 data

ENV NODE_ENV=production

# 启动命令 (直接读取平台分配的 PORT，若未指定则兜底 8080)
CMD ["node", "src/server.mjs"]

