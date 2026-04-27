# Safebox Multi-Tenant Architecture — Complete System Design

**Architecture:** Containerized multi-tenant hosting platform with ZFS clones, model runners, and web-based management.

---

## 🏗️ System Architecture (SVG Diagram)

```svg
<svg viewBox="0 0 1200 900" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="1200" height="900" fill="#f8f9fa"/>
  
  <!-- Title -->
  <text x="600" y="30" font-size="24" font-weight="bold" text-anchor="middle" fill="#1a1a1a">
    Safebox Multi-Tenant Hosting Platform
  </text>
  
  <!-- Host/Owner Layer -->
  <rect x="50" y="60" width="1100" height="100" fill="#e3f2fd" stroke="#1976d2" stroke-width="2" rx="5"/>
  <text x="70" y="85" font-size="16" font-weight="bold" fill="#1976d2">Safebox Host (Owner)</text>
  <text x="70" y="110" font-size="12" fill="#424242">• Provisions tenant apps</text>
  <text x="70" y="130" font-size="12" fill="#424242">• Manages infrastructure</text>
  <text x="70" y="150" font-size="12" fill="#424242">• Monitors resources</text>
  
  <text x="400" y="110" font-size="12" fill="#424242">Management Interface (Safebox/hosting)</text>
  <rect x="390" y="120" width="220" height="30" fill="#fff" stroke="#1976d2" stroke-width="1" rx="3"/>
  <text x="500" y="140" font-size="11" text-anchor="middle" fill="#1976d2">https://host.safebox.app</text>
  
  <!-- ZFS Layer -->
  <rect x="50" y="180" width="350" height="200" fill="#fff3e0" stroke="#f57c00" stroke-width="2" rx="5"/>
  <text x="70" y="205" font-size="14" font-weight="bold" fill="#f57c00">ZFS Storage Pool</text>
  
  <!-- Platform Base -->
  <rect x="70" y="220" width="300" height="40" fill="#ffe0b2" stroke="#f57c00" stroke-width="1" rx="3"/>
  <text x="220" y="245" font-size="12" text-anchor="middle" fill="#e65100">qbix-platform@base (snapshot)</text>
  
  <!-- App Clones -->
  <g>
    <rect x="80" y="270" width="130" height="30" fill="#fff" stroke="#f57c00" stroke-width="1" rx="2"/>
    <text x="145" y="290" font-size="11" text-anchor="middle" fill="#424242">safebox (clone)</text>
  </g>
  <g>
    <rect x="80" y="310" width="130" height="30" fill="#fff" stroke="#f57c00" stroke-width="1" rx="2"/>
    <text x="145" y="330" font-size="11" text-anchor="middle" fill="#424242">community-x (clone)</text>
  </g>
  <g>
    <rect x="230" y="270" width="130" height="30" fill="#fff" stroke="#f57c00" stroke-width="1" rx="2"/>
    <text x="295" y="290" font-size="11" text-anchor="middle" fill="#424242">business-y (clone)</text>
  </g>
  <text x="145" y="360" font-size="10" text-anchor="middle" fill="#757575">Copy-on-write clones</text>
  
  <!-- Docker Containers -->
  <rect x="420" y="180" width="730" height="460" fill="#e8f5e9" stroke="#388e3c" stroke-width="2" rx="5"/>
  <text x="440" y="205" font-size="14" font-weight="bold" fill="#388e3c">Docker Containers</text>
  
  <!-- Infrastructure Containers -->
  <g id="infra">
    <text x="440" y="230" font-size="12" font-weight="bold" fill="#2e7d32">Infrastructure</text>
    
    <!-- Nginx -->
    <rect x="440" y="240" width="100" height="60" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="490" y="260" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">nginx</text>
    <text x="490" y="275" font-size="9" text-anchor="middle" fill="#424242">:80, :443</text>
    <text x="490" y="288" font-size="9" text-anchor="middle" fill="#666">sites-enabled/</text>
    
    <!-- MariaDB -->
    <rect x="550" y="240" width="100" height="60" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="600" y="260" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">mariadb</text>
    <text x="600" y="275" font-size="9" text-anchor="middle" fill="#424242">:3306</text>
    <text x="600" y="288" font-size="9" text-anchor="middle" fill="#666">Multi-DB</text>
    
    <!-- Redis -->
    <rect x="660" y="240" width="100" height="60" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="710" y="260" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">redis</text>
    <text x="710" y="275" font-size="9" text-anchor="middle" fill="#424242">:6379</text>
    <text x="710" y="288" font-size="9" text-anchor="middle" fill="#666">Cache</text>
  </g>
  
  <!-- App Containers -->
  <g id="apps">
    <text x="440" y="325" font-size="12" font-weight="bold" fill="#2e7d32">App Containers (Qbix)</text>
    
    <!-- App 1 -->
    <rect x="440" y="335" width="150" height="80" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="515" y="355" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">safebox-app-safebox</text>
    <text x="515" y="370" font-size="9" text-anchor="middle" fill="#424242">Platform: /zpool/.../safebox:ro</text>
    <text x="515" y="383" font-size="9" text-anchor="middle" fill="#424242">Data: /zpool/app-data/safebox</text>
    <text x="515" y="396" font-size="9" text-anchor="middle" fill="#424242">Web: /web → nginx</text>
    <text x="515" y="409" font-size="9" text-anchor="middle" fill="#666">safebox.example.com</text>
    
    <!-- App 2 -->
    <rect x="610" y="335" width="150" height="80" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="685" y="355" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">community-x</text>
    <text x="685" y="370" font-size="9" text-anchor="middle" fill="#424242">Platform: /zpool/.../community-x:ro</text>
    <text x="685" y="383" font-size="9" text-anchor="middle" fill="#424242">Data: /zpool/app-data/community-x</text>
    <text x="685" y="396" font-size="9" text-anchor="middle" fill="#424242">Web: /web → nginx</text>
    <text x="685" y="409" font-size="9" text-anchor="middle" fill="#666">community-x.com</text>
    
    <!-- App 3 -->
    <rect x="780" y="335" width="150" height="80" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="855" y="355" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">business-y</text>
    <text x="855" y="370" font-size="9" text-anchor="middle" fill="#424242">Platform: /zpool/.../business-y:ro</text>
    <text x="855" y="383" font-size="9" text-anchor="middle" fill="#424242">Data: /zpool/app-data/business-y</text>
    <text x="855" y="396" font-size="9" text-anchor="middle" fill="#424242">Web: /web → nginx</text>
    <text x="855" y="409" font-size="9" text-anchor="middle" fill="#666">business-y.net</text>
  </g>
  
  <!-- Model Runners -->
  <g id="models">
    <text x="440" y="440" font-size="12" font-weight="bold" fill="#2e7d32">Model Runners (Shared via Unix Sockets)</text>
    
    <!-- LLM -->
    <rect x="440" y="450" width="120" height="70" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="500" y="470" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">vLLM</text>
    <text x="500" y="485" font-size="9" text-anchor="middle" fill="#424242">llama-3.1-8b</text>
    <text x="500" y="498" font-size="9" text-anchor="middle" fill="#666">GPU 0</text>
    <text x="500" y="511" font-size="8" text-anchor="middle" fill="#888">/run/.../model-llm-1.sock</text>
    
    <!-- Image -->
    <rect x="570" y="450" width="120" height="70" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="630" y="470" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">ComfyUI</text>
    <text x="630" y="485" font-size="9" text-anchor="middle" fill="#424242">SDXL 1.0</text>
    <text x="630" y="498" font-size="9" text-anchor="middle" fill="#666">GPU 1</text>
    <text x="630" y="511" font-size="8" text-anchor="middle" fill="#888">/run/.../model-vision-1.sock</text>
    
    <!-- Privacy -->
    <rect x="700" y="450" width="120" height="70" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="760" y="470" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">Privacy Filter</text>
    <text x="760" y="485" font-size="9" text-anchor="middle" fill="#424242">PII Detection</text>
    <text x="760" y="498" font-size="9" text-anchor="middle" fill="#666">CPU</text>
    <text x="760" y="511" font-size="8" text-anchor="middle" fill="#888">/run/.../privacy-filter-1.sock</text>
  </g>
  
  <!-- Utility Containers -->
  <g id="utils">
    <text x="440" y="545" font-size="12" font-weight="bold" fill="#2e7d32">Utility Containers (Shared)</text>
    
    <!-- FFmpeg -->
    <rect x="440" y="555" width="100" height="60" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="490" y="575" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">ffmpeg</text>
    <text x="490" y="590" font-size="9" text-anchor="middle" fill="#424242">Video/Audio</text>
    <text x="490" y="603" font-size="8" text-anchor="middle" fill="#888">/run/.../ffmpeg.sock</text>
    
    <!-- ImageMagick -->
    <rect x="550" y="555" width="100" height="60" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="600" y="575" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">imagemagick</text>
    <text x="600" y="590" font-size="9" text-anchor="middle" fill="#424242">Image Ops</text>
    <text x="600" y="603" font-size="8" text-anchor="middle" fill="#888">/run/.../imagemagick.sock</text>
    
    <!-- Backup Agent -->
    <rect x="660" y="555" width="100" height="60" fill="#fff" stroke="#388e3c" stroke-width="1" rx="3"/>
    <text x="710" y="575" font-size="11" font-weight="bold" text-anchor="middle" fill="#2e7d32">backup-agent</text>
    <text x="710" y="590" font-size="9" text-anchor="middle" fill="#424242">SafeCloud Sync</text>
    <text x="710" y="603" font-size="8" text-anchor="middle" fill="#888">rsync/DH-tunnel</text>
  </g>
  
  <!-- Management -->
  <rect x="950" y="240" width="180" height="160" fill="#fff9c4" stroke="#f9a825" stroke-width="2" rx="5"/>
  <text x="1040" y="260" font-size="12" font-weight="bold" text-anchor="middle" fill="#f57f17">Management</text>
  <text x="1040" y="280" font-size="10" text-anchor="middle" fill="#424242">Safebox/hosting Plugin</text>
  <line x1="960" y1="285" x2="1120" y2="285" stroke="#f9a825" stroke-width="1"/>
  <text x="960" y="300" font-size="10" fill="#424242">• Provision apps</text>
  <text x="960" y="318" font-size="10" fill="#424242">• Manage domains</text>
  <text x="960" y="336" font-size="10" fill="#424242">• SSL certs (Let's Encrypt)</text>
  <text x="960" y="354" font-size="10" fill="#424242">• Resource monitoring</text>
  <text x="960" y="372" font-size="10" fill="#424242">• Backup scheduling</text>
  <text x="960" y="390" font-size="10" fill="#424242">• Tenant contracts</text>
  
  <!-- Backups -->
  <rect x="50" y="660" width="1100" height="180" fill="#fce4ec" stroke="#c2185b" stroke-width="2" rx="5"/>
  <text x="70" y="685" font-size="14" font-weight="bold" fill="#c2185b">Backup &amp; Replication</text>
  
  <!-- Local Backups -->
  <g>
    <text x="70" y="710" font-size="12" font-weight="bold" fill="#880e4f">Local (Host)</text>
    <rect x="70" y="720" width="200" height="100" fill="#fff" stroke="#c2185b" stroke-width="1" rx="3"/>
    <text x="170" y="740" font-size="11" text-anchor="middle" fill="#424242">ZFS Snapshots</text>
    <text x="170" y="758" font-size="9" text-anchor="middle" fill="#666">Hourly: 24h retention</text>
    <text x="170" y="773" font-size="9" text-anchor="middle" fill="#666">Daily: 30d retention</text>
    <text x="170" y="788" font-size="9" text-anchor="middle" fill="#666">MySQL: FLUSH TABLES</text>
    <text x="170" y="803" font-size="9" text-anchor="middle" fill="#666">→ zfs snapshot</text>
  </g>
  
  <!-- Remote Backups -->
  <g>
    <text x="300" y="710" font-size="12" font-weight="bold" fill="#880e4f">Remote (Peer Safebox)</text>
    <rect x="300" y="720" width="250" height="100" fill="#fff" stroke="#c2185b" stroke-width="1" rx="3"/>
    <text x="425" y="740" font-size="11" text-anchor="middle" fill="#424242">SafeCloud Protocol</text>
    <text x="425" y="758" font-size="9" text-anchor="middle" fill="#666">1. FLUSH TABLES WITH READ LOCK</text>
    <text x="425" y="773" font-size="9" text-anchor="middle" fill="#666">2. rsync over DH-encrypted tunnel</text>
    <text x="425" y="788" font-size="9" text-anchor="middle" fill="#666">3. UNLOCK TABLES</text>
    <text x="425" y="803" font-size="9" text-anchor="middle" fill="#666">Pluggable: rsync, SafeCloud chunks</text>
  </g>
  
  <!-- Backup Schedule -->
  <g>
    <text x="580" y="710" font-size="12" font-weight="bold" fill="#880e4f">Schedule</text>
    <rect x="580" y="720" width="200" height="100" fill="#fff" stroke="#c2185b" stroke-width="1" rx="3"/>
    <text x="680" y="740" font-size="10" text-anchor="middle" fill="#424242">Per-tenant contracts:</text>
    <text x="680" y="758" font-size="9" text-anchor="middle" fill="#666">• Backup frequency</text>
    <text x="680" y="773" font-size="9" text-anchor="middle" fill="#666">• Retention policy</text>
    <text x="680" y="788" font-size="9" text-anchor="middle" fill="#666">• Peer Safebox URL</text>
    <text x="680" y="803" font-size="9" text-anchor="middle" fill="#666">• Storage quota</text>
  </g>
  
  <!-- Tenant Admin -->
  <g>
    <text x="810" y="710" font-size="12" font-weight="bold" fill="#880e4f">Tenant Admin Access</text>
    <rect x="810" y="720" width="320" height="100" fill="#fff" stroke="#c2185b" stroke-width="1" rx="3"/>
    <text x="970" y="740" font-size="10" text-anchor="middle" fill="#424242">First visitor to app URL = admin</text>
    <text x="970" y="758" font-size="9" text-anchor="middle" fill="#666">1. Tenant visits https://community-x.com/</text>
    <text x="970" y="773" font-size="9" text-anchor="middle" fill="#666">2. Qbix detects: no admin yet</text>
    <text x="970" y="788" font-size="9" text-anchor="middle" fill="#666">3. Prompt: "Become admin? (contact host)"</text>
    <text x="970" y="803" font-size="9" text-anchor="middle" fill="#666">4. Host confirms → admin role granted</text>
  </g>
  
  <!-- Legend -->
  <g id="legend">
    <text x="50" y="870" font-size="10" font-weight="bold" fill="#424242">Legend:</text>
    <rect x="110" y="860" width="15" height="15" fill="#e3f2fd" stroke="#1976d2"/>
    <text x="130" y="872" font-size="9" fill="#424242">Host Layer</text>
    <rect x="200" y="860" width="15" height="15" fill="#fff3e0" stroke="#f57c00"/>
    <text x="220" y="872" font-size="9" fill="#424242">ZFS Storage</text>
    <rect x="300" y="860" width="15" height="15" fill="#e8f5e9" stroke="#388e3c"/>
    <text x="320" y="872" font-size="9" fill="#424242">Docker Containers</text>
    <rect x="430" y="860" width="15" height="15" fill="#fff9c4" stroke="#f9a825"/>
    <text x="450" y="872" font-size="9" fill="#424242">Management</text>
    <rect x="550" y="860" width="15" height="15" fill="#fce4ec" stroke="#c2185b"/>
    <text x="570" y="872" font-size="9" fill="#424242">Backup/Replication</text>
  </g>
</svg>
```

---

## 🎯 Management Interface Design

### **Safebox/hosting Plugin**

**URL:** `https://host.safebox.app/Safebox/hosting`

**Three User Roles:**

1. **Host/Owner** - Safebox infrastructure owner
2. **Tenant** - App owner (community/business)
3. **End User** - App visitor

---

## 📱 Host Management Interface

### **Dashboard** (`/Safebox/hosting`)

```
┌─────────────────────────────────────────────────────────┐
│ Safebox Hosting — host.safebox.app                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Resource Usage                                          │
│ ├─ CPU: ████████░░ 78% (16 cores)                     │
│ ├─ RAM: ██████████ 92% (128GB / 140GB)                │
│ ├─ GPU: ████░░░░░░ 45% (8× H100)                      │
│ └─ ZFS: ████░░░░░░ 42% (2.1TB / 5TB)                  │
│                                                         │
│ Active Apps: 12                                         │
│ Model Runners: 4 healthy                                │
│ Pending Contracts: 2                                    │
│                                                         │
│ [➕ Provision New App] [📊 Monitoring] [⚙️ Settings]  │
└─────────────────────────────────────────────────────────┘
```

### **App List** (`/Safebox/hosting/apps`)

```
┌─────────────────────────────────────────────────────────┐
│ Managed Apps                                [➕ New App]│
├──────────────┬────────────┬─────────┬────────────────────┤
│ App Name     │ Domain     │ Status  │ Resources         │
├──────────────┼────────────┼─────────┼────────────────────┤
│ Safebox      │ safebox... │ ✅ Up   │ 2GB RAM, 5GB disk │
│ CommunityX   │ communi... │ ✅ Up   │ 1GB RAM, 3GB disk │
│ BusinessY    │ business...│ ⚠️ Load │ 4GB RAM, 12GB disk│
│ StartupZ     │ startup... │ 🔧 Maint│ 1GB RAM, 2GB disk │
└──────────────┴────────────┴─────────┴────────────────────┘
```

### **Provision New App** (`/Safebox/hosting/provision`)

```
┌─────────────────────────────────────────────────────────┐
│ Provision New App                                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ App Name: [                    ]                        │
│ Domain: [                      ] .safebox.app          │
│          ↑ or custom domain                            │
│                                                         │
│ Tenant Email: [                    ]                    │
│                                                         │
│ Resources:                                              │
│ ├─ ZFS Quota: [ 10 ] GB                                │
│ ├─ RAM Limit: [  2 ] GB                                │
│ └─ MySQL Quota: [  5 ] GB                              │
│                                                         │
│ Backup:                                                 │
│ ├─ Frequency: [Daily ▾]                                │
│ ├─ Retention: [ 30 ] days                              │
│ └─ Peer Safebox: [                        ]  (optional)│
│                                                         │
│ [Cancel]                          [Create App Contract]│
└─────────────────────────────────────────────────────────┘
```

**What happens on submit:**

1. Creates ZFS clone: `zpool/qbix-platform/<app-name>`
2. Creates app data: `zpool/app-data/<app-name>`
3. Creates MySQL database: `<app_name>`
4. Generates docker-compose entry
5. Configures nginx site: `/etc/nginx/sites-enabled/<domain>`
6. Gets SSL cert: `certbot --nginx -d <domain>`
7. Starts container: `docker-compose up -d safebox-app-<app-name>`
8. Sends email to tenant with access info

---

## 🏢 Tenant Contract Flow

### **1. Host Creates Contract**

```javascript
// Host clicks "Provision New App"
await Q.Streams.create('Safebox', 'Safebox/hosting/contract', {
    content: JSON.stringify({
        appName: 'community-x',
        domain: 'community-x.com',
        tenantEmail: 'admin@community-x.com',
        resources: {
            zfsQuotaGB: 10,
            ramLimitGB: 2,
            mysqlQuotaGB: 5
        },
        backup: {
            frequency: 'daily',
            retentionDays: 30,
            peerSafeboxUrl: 'https://backup.partner-safebox.com'
        },
        status: 'pending'
    })
});
```

### **2. Tenant Accepts Contract**

Tenant receives email:

```
Subject: Safebox Hosting — App Provisioned

Your app "CommunityX" has been provisioned on our Safebox.

App URL: https://community-x.com
Admin Setup: Click below to become the first admin

[Become Admin]

Resources:
- Storage: 10GB
- RAM: 2GB
- Database: 5GB
- Backup: Daily to peer Safebox

Host: host.safebox.app
Contract: https://host.safebox.app/Safebox/hosting/contract/abc123
```

### **3. First Visitor = Admin**

When tenant clicks "Become Admin":

```javascript
// User visits https://community-x.com/admin/setup
// Qbix detects: no admin role exists

if (Q.Users.roles.length === 0) {
    // Show dialog
    Q.Dialogs.push({
        title: "Become Administrator?",
        content: `
            <p>You are the first visitor to this app.</p>
            <p>Would you like to become the administrator?</p>
            <p><strong>This will send a confirmation request to the host.</strong></p>
        `,
        buttons: {
            confirm: {
                label: "Request Admin Access",
                handler: async function() {
                    // Create admin request
                    await Q.req('Safebox/hosting/requestAdmin', [], {
                        method: 'POST',
                        fields: {
                            appName: 'community-x',
                            email: Q.Users.loggedInUser.emailAddress
                        }
                    });
                    
                    Q.alert("Request sent to host. Check your email.");
                }
            }
        }
    });
}
```

### **4. Host Approves Admin**

Host sees notification:

```
┌─────────────────────────────────────────────────────────┐
│ Admin Request — CommunityX                              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ User: admin@community-x.com                             │
│ App: CommunityX (community-x.com)                       │
│                                                         │
│ Contract verified: ✅ Tenant email matches              │
│                                                         │
│ [Deny]                                       [Approve] │
└─────────────────────────────────────────────────────────┘
```

On approve:

```javascript
// Grant admin role
await Q.Users.setRoles('community-x', 'userId123', ['Users/admins']);

// Send confirmation email
await Q.req('Users/email', [], {
    method: 'POST',
    fields: {
        to: 'admin@community-x.com',
        subject: 'Admin Access Granted',
        body: `
            You are now the administrator of CommunityX.
            
            Access your admin panel: https://community-x.com/admin
        `
    }
});
```

---

## 🌐 Nginx Management

### **Architecture**

```
nginx Container
├── /etc/nginx/sites-enabled/
│   ├── safebox.example.com.conf
│   ├── community-x.com.conf
│   └── business-y.net.conf
├── /etc/letsencrypt/
│   ├── live/safebox.example.com/
│   ├── live/community-x.com/
│   └── live/business-y.net/
```

### **Auto-Generated Site Config**

When app is provisioned, create `/etc/nginx/sites-enabled/<domain>.conf`:

```nginx
# Auto-generated by Safebox/hosting
# App: community-x
# Domain: community-x.com

server {
    listen 80;
    listen [::]:80;
    server_name community-x.com www.community-x.com;
    
    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    # Redirect to HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name community-x.com www.community-x.com;
    
    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/community-x.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/community-x.com/privkey.pem;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    
    # App container (Qbix)
    location / {
        proxy_pass http://safebox-app-community-x:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Static files from /web (mounted from ZFS)
    location /Q/web/ {
        alias /zpool/app-data/community-x/web/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### **SSL Certificate Management**

**Automated via Safebox/hosting:**

```javascript
// On app provision
async function provisionSSL(domain) {
    // 1. Add nginx config
    await writeNginxConfig(domain);
    
    // 2. Reload nginx
    await exec('docker exec safebox-nginx nginx -s reload');
    
    // 3. Get Let's Encrypt cert
    await exec(`
        docker exec safebox-nginx \
        certbot --nginx \
        -d ${domain} \
        -d www.${domain} \
        --non-interactive \
        --agree-tos \
        --email admin@${hostDomain}
    `);
    
    // 4. Setup auto-renewal cron
    await setupCertbotRenewal();
}
```

**Tenant can manage cert from their admin panel:**

```
┌─────────────────────────────────────────────────────────┐
│ CommunityX — Admin Panel                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ SSL Certificate                                         │
│ ├─ Status: ✅ Valid (expires in 67 days)              │
│ ├─ Domain: community-x.com                             │
│ └─ Issuer: Let's Encrypt                               │
│                                                         │
│ [Renew Now] (auto-renews 30 days before expiry)       │
└─────────────────────────────────────────────────────────┘
```

---

## 💾 Backup Architecture

### **MySQL Backup with FLUSH TABLES**

```javascript
// Safebox/hosting/backup
async function backupApp(appName) {
    const dbName = appName.replace(/-/g, '_');
    
    // 1. Flush tables and lock
    await mysql.query(`FLUSH TABLES WITH READ LOCK`);
    
    try {
        // 2. ZFS snapshot
        await exec(`zfs snapshot zpool/app-data/${appName}@backup-${Date.now()}`);
        
        // 3. Sync to peer Safebox (if configured)
        const contract = await getContract(appName);
        if (contract.backup.peerSafeboxUrl) {
            await syncToPeer(appName, contract.backup.peerSafeboxUrl);
        }
    } finally {
        // 4. Unlock tables
        await mysql.query(`UNLOCK TABLES`);
    }
}

async function syncToPeer(appName, peerUrl) {
    // Option 1: rsync over SSH with DH-encrypted tunnel
    await exec(`
        rsync -avz --delete \
        -e "ssh -i /etc/safebox/backup.key" \
        /zpool/app-data/${appName}/ \
        backup@${peerUrl}:/backups/${appName}/
    `);
    
    // Option 2: SafeCloud protocol (chunked sync)
    // await SafeCloud.sync({
    //     source: `/zpool/app-data/${appName}`,
    //     destination: `${peerUrl}/backups/${appName}`,
    //     encryption: 'dh-tunnel'
    // });
}
```

### **Backup Scheduling**

```javascript
// Cron job managed by Safebox/hosting
const backupSchedules = {
    'safebox': { frequency: 'hourly', retention: '7d' },
    'community-x': { frequency: 'daily', retention: '30d' },
    'business-y': { frequency: 'daily', retention: '90d' }
};

// Run via node-cron
cron.schedule('0 * * * *', async () => {
    for (const [appName, config] of Object.entries(backupSchedules)) {
        if (shouldBackup(appName, config.frequency)) {
            await backupApp(appName);
            await pruneOldBackups(appName, config.retention);
        }
    }
});
```

---

## ✅ Implementation Checklist

### **Host Setup**

- [ ] Install ZFS and create pool
- [ ] Run `setup-zfs-clones.sh` to create base platform snapshot
- [ ] Deploy infrastructure containers (nginx, mariadb, redis)
- [ ] Deploy model runners and utilities
- [ ] Install Safebox/hosting plugin
- [ ] Configure backup peer (optional)

### **Per-App Provisioning**

- [ ] Run `create-app-clone.sh <app-name>`
- [ ] Create contract stream
- [ ] Generate nginx config
- [ ] Get SSL certificate
- [ ] Add to docker-compose
- [ ] Start container
- [ ] Email tenant with access info

### **Tenant Onboarding**

- [ ] Tenant receives email
- [ ] Tenant visits app URL
- [ ] Tenant requests admin access
- [ ] Host approves request
- [ ] Tenant configures app

---

## 🎉 Summary

**Complete multi-tenant architecture with:**

✅ ZFS clones per app (isolation + efficiency)  
✅ Containerized everything (Qbix, models, utilities)  
✅ Web-based management (Safebox/hosting)  
✅ Automated provisioning (one-click app creation)  
✅ Contract-based tenancy (host ↔ tenant agreements)  
✅ First-visitor admin (secure, simple onboarding)  
✅ Nginx + SSL automation (Let's Encrypt)  
✅ MySQL backups (FLUSH TABLES + ZFS snapshots)  
✅ Peer replication (rsync or SafeCloud)  

**Ready for production multi-tenant hosting!**
