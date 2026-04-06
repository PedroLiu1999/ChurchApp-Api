#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# docker-entrypoint.sh
#
# Generates config/selfhost.json from environment variables at container start,
# then hands off to the main process.
#
# All values here have safe defaults; secrets (DB passwords, keys, etc.) are
# never written into the JSON — they are read directly from process.env at
# runtime by Environment.ts.
# ─────────────────────────────────────────────────────────────────────────────

set -e

# Derive the public API base URL from CADDY_HOST (set in .env)
API_URL="${API_URL:-https://${CADDY_HOST:-localhost}}"

# CONTENT_ROOT: use env var if set, otherwise derive from API_URL
CONTENT_ROOT="${CONTENT_ROOT:-${API_URL}/content/}"

# B1Admin root (used for email registration links)
B1ADMIN_ROOT="${B1Admin_ROOT:-${B1ADMIN_ROOT:-${API_URL}/admin}}"

# Mail system: SMTP (default for selfhost) or SES
MAIL_SYSTEM="${MAIL_SYSTEM:-SMTP}"

# File store: S3 (OCI-compatible) or disk
FILE_STORE="${FILE_STORE:-S3}"

# S3 bucket name
S3_BUCKET="${AWS_S3_BUCKET:-churchapps-content}"

# Delivery provider
DELIVERY_PROVIDER="${DELIVERY_PROVIDER:-smtp}"

# Email on registration
EMAIL_ON_REGISTRATION="${EMAIL_ON_REGISTRATION:-true}"

# Support email
SUPPORT_EMAIL="${SUPPORT_EMAIL:-noreply@${CADDY_HOST:-localhost}}"

# AI provider
AI_PROVIDER="${AI_PROVIDER:-}"

# Store API URL
STORE_API_URL="${STORE_API_URL:-}"

# Messaging API (used by initializeModuleConfigs)
MESSAGING_API="${API_URL}/messaging"

mkdir -p /app/config

cat > /app/config/selfhost.json <<EOF
{
  "environment": "selfhost",
  "apiUrl": "${API_URL}",
  "deliveryProvider": "${DELIVERY_PROVIDER}",
  "appName": "API",
  "contentRoot": "${CONTENT_ROOT}",
  "emailOnRegistration": ${EMAIL_ON_REGISTRATION},
  "fileStore": "${FILE_STORE}",
  "mailSystem": "${MAIL_SYSTEM}",
  "s3Bucket": "${S3_BUCKET}",
  "supportEmail": "${SUPPORT_EMAIL}",
  "b1AdminRoot": "${B1ADMIN_ROOT}",
  "messagingApi": "${MESSAGING_API}",
  "aiProvider": "${AI_PROVIDER}",
  "storeApi": "${STORE_API_URL}"
}
EOF

echo "✅ Generated /app/config/selfhost.json"
echo "   apiUrl          : ${API_URL}"
echo "   contentRoot     : ${CONTENT_ROOT}"
echo "   b1AdminRoot     : ${B1ADMIN_ROOT}"
echo "   mailSystem      : ${MAIL_SYSTEM}"
echo "   fileStore       : ${FILE_STORE}"
echo "   deliveryProvider: ${DELIVERY_PROVIDER}"

# Hand off to the main process (passed as CMD arguments)
exec "$@"
