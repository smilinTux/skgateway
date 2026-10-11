#!/usr/bin/env bash
#
# generate-deployment-manifest.sh
# Generates a deployment manifest for SKGateway instances
#
# Usage: generate-deployment-manifest.sh <bundle-id> [output-file]
#

set -euo pipefail

GREEN='\033[0;32m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }

if [ $# -lt 1 ]; then
  echo "Usage: $0 <bundle-id> [output-file]"
  echo "Example: $0 skgateway-0.1.0-7231a0ab298c deployment.json"
  exit 1
fi

BUNDLE_ID="$1"
OUTPUT_FILE="${2:-deployment.json}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log_info "Generating deployment manifest for bundle: $BUNDLE_ID"
log_info "Output file: $OUTPUT_FILE"

# Generate deployment manifest
cat > "$OUTPUT_FILE" << MANIFEST
{
  "deployment_type": "skgateway-immutable-v1",
  "bundle_id": "$BUNDLE_ID",
  "created_at": "$TIMESTAMP",
  "instances": [
    {
      "name": "skgateway-lifecycle",
      "port": 18951,
      "bind": "127.0.0.1",
      "dashboard_port": 18952,
      "config_path": "/etc/skgateway/lifecycle.yaml",
      "data_path": "/var/lib/skgateway/lifecycle",
      "log_path": "/var/log/skgateway/lifecycle",
      "user": "skgateway",
      "group": "skgateway",
      "environment": {
        "NODE_ENV": "production",
        "SKG_INSTANCE": "lifecycle"
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/healthz",
        "interval_seconds": 30,
        "timeout_seconds": 5,
        "unhealthy_threshold": 3,
        "healthy_threshold": 2
      },
      "resources": {
        "memory_limit": "512M",
        "cpu_limit": "1.0"
      }
    },
    {
      "name": "skgateway-authz",
      "port": 18942,
      "bind": "127.0.0.1",
      "dashboard_port": 18943,
      "config_path": "/etc/skgateway/authz.yaml",
      "data_path": "/var/lib/skgateway/authz",
      "log_path": "/var/log/skgateway/authz",
      "user": "skgateway",
      "group": "skgateway",
      "environment": {
        "NODE_ENV": "production",
        "SKG_INSTANCE": "authz"
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/healthz",
        "interval_seconds": 30,
        "timeout_seconds": 5,
        "unhealthy_threshold": 3,
        "healthy_threshold": 2
      },
      "resources": {
        "memory_limit": "512M",
        "cpu_limit": "1.0"
      }
    },
    {
      "name": "skgateway-rail-attrib",
      "port": 39831,
      "bind": "127.0.0.1",
      "dashboard_port": 39832,
      "config_path": "/etc/skgateway/rail-attrib.yaml",
      "data_path": "/var/lib/skgateway/rail-attrib",
      "log_path": "/var/log/skgateway/rail-attrib",
      "user": "skgateway",
      "group": "skgateway",
      "environment": {
        "NODE_ENV": "production",
        "SKG_INSTANCE": "rail-attrib"
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/healthz",
        "interval_seconds": 30,
        "timeout_seconds": 5,
        "unhealthy_threshold": 3,
        "healthy_threshold": 2
      },
      "resources": {
        "memory_limit": "512M",
        "cpu_limit": "1.0"
      }
    },
    {
      "name": "skgateway-attrib-1",
      "port": 42621,
      "bind": "127.0.0.1",
      "dashboard_port": 42622,
      "config_path": "/etc/skgateway/attrib-1.yaml",
      "data_path": "/var/lib/skgateway/attrib-1",
      "log_path": "/var/log/skgateway/attrib-1",
      "user": "skgateway",
      "group": "skgateway",
      "environment": {
        "NODE_ENV": "production",
        "SKG_INSTANCE": "attrib-1"
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/healthz",
        "interval_seconds": 30,
        "timeout_seconds": 5,
        "unhealthy_threshold": 3,
        "healthy_threshold": 2
      },
      "resources": {
        "memory_limit": "512M",
        "cpu_limit": "1.0"
      }
    },
    {
      "name": "skgateway-attrib-2",
      "port": 42123,
      "bind": "127.0.0.1",
      "dashboard_port": 42124,
      "config_path": "/etc/skgateway/attrib-2.yaml",
      "data_path": "/var/lib/skgateway/attrib-2",
      "log_path": "/var/log/skgateway/attrib-2",
      "user": "skgateway",
      "group": "skgateway",
      "environment": {
        "NODE_ENV": "production",
        "SKG_INSTANCE": "attrib-2"
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/healthz",
        "interval_seconds": 30,
        "timeout_seconds": 5,
        "unhealthy_threshold": 3,
        "healthy_threshold": 2
      },
      "resources": {
        "memory_limit": "512M",
        "cpu_limit": "1.0"
      }
    },
    {
      "name": "skgateway-authz-2",
      "port": 18944,
      "bind": "127.0.0.1",
      "dashboard_port": 18945,
      "config_path": "/etc/skgateway/authz-2.yaml",
      "data_path": "/var/lib/skgateway/authz-2",
      "log_path": "/var/log/skgateway/authz-2",
      "user": "skgateway",
      "group": "skgateway",
      "environment": {
        "NODE_ENV": "production",
        "SKG_INSTANCE": "authz-2"
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/healthz",
        "interval_seconds": 30,
        "timeout_seconds": 5,
        "unhealthy_threshold": 3,
        "healthy_threshold": 2
      },
      "resources": {
        "memory_limit": "512M",
        "cpu_limit": "1.0"
      }
    }
  ],
  "rollback": {
    "enabled": true,
    "previous_bundle": null,
    "rollback_command": "/usr/local/bin/skgateway-rollback --instance {name}",
    "data_preserved": true,
    "config_preserved": true
  },
  "storage": {
    "bundle_base_path": "/opt/skgateway/bundles",
    "active_base_path": "/opt/skgateway/active",
    "config_base_path": "/etc/skgateway",
    "data_base_path": "/var/lib/skgateway",
    "log_base_path": "/var/log/skgateway"
  },
  "network": {
    "bind_default": "127.0.0.1",
    "port_allocation": {
      "lifecycle": 18951,
      "authz": 18942,
      "rail-attrib": 39831,
      "attrib-1": 42621,
      "attrib-2": 42123,
      "authz-2": 18944
    }
  }
}
MANIFEST

log_info ""
log_info "Deployment manifest created: $OUTPUT_FILE"
log_info "Instances defined: 6"
log_info ""

exit 0
