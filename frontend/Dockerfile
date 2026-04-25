# syntax=docker/dockerfile:1.6
# StrikeForge Frontend — Multi-stage Vite build → nginx static serving

#####################################
# Stage 1: builder — produce dist/
#####################################
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy source and build
COPY . .
RUN npm run build


#####################################
# Stage 2: production — nginx serving on :8080
#####################################
FROM nginx:1.27-alpine AS production

# Replace default nginx config with SPA-aware config on port 8080
RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen 8080;
    listen [::]:8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/json application/xml application/xml+rss image/svg+xml;

    # Hashed asset files: cache forever (filename includes hash)
    location ~* ^/assets/.*\.(js|css|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|otf|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Health endpoint for Cloud Run platform probes
    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok";
    }

    # Index HTML: never cache
    location = / {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files /index.html =404;
    }

    # SPA fallback for client-side routing
    location / {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri $uri/ /index.html;
    }
}
EOF

# Remove default nginx welcome page
RUN rm -f /usr/share/nginx/html/index.html

# Copy built static assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
