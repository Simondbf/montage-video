server {
    listen 80;
    server_name montage.soleiljaune.be;

    # Photos et vidéos envoyées depuis le téléphone ou l'ordinateur : jusqu'à 4 Go chacune.
    client_max_body_size 5G;

    location / {
        proxy_pass http://127.0.0.1:3013;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
