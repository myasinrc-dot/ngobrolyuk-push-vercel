let cachedAccessToken = "";
let cachedTokenExp = 0;

function base64UrlEncode(input) {
  let str = "";
  if (typeof input === "string") {
    const utf8 = new TextEncoder().encode(input);
    for (let i = 0; i < utf8.length; i++) {
      str += String.fromCharCode(utf8[i]);
    }
  } else {
    const bytes = new Uint8Array(input);
    for (let i = 0; i < bytes.length; i++) {
      str += String.fromCharCode(bytes[i]);
    }
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && now < cachedTokenExp - 60) {
    return cachedAccessToken;
  }

  const pemClean = process.env.FIREBASE_PRIVATE_KEY
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binaryStr = atob(pemClean);
  const keyBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    keyBytes[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: process.env.FIREBASE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3500
    })
  );

  const unsignedJwt = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedJwt)
  );
  const signedJwt = `${unsignedJwt}.${base64UrlEncode(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signedJwt}`
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Gagal mendapatkan Google Access Token: " + JSON.stringify(data));
  }

  cachedAccessToken = data.access_token;
  cachedTokenExp = now + (data.expires_in || 3500);
  return cachedAccessToken;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Gunakan metode POST" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { nomorTujuan, judul, isi, targetId, targetTipe, namaPenerima } = body;

    if (!nomorTujuan) {
      return res.status(400).json({ ok: false, error: "nomorTujuan kosong" });
    }

    const accessToken = await getGoogleAccessToken();
    const dbBase = process.env.FIREBASE_DB_URL.replace(/\/$/, "");
    const tokenUrl = `${dbBase}/fcm_tokens/${encodeURIComponent(nomorTujuan)}.json?access_token=${accessToken}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenMap = await tokenRes.json();

    if (!tokenMap || typeof tokenMap !== "object") {
      return res.status(200).json({ ok: true, sent: 0, info: "Penerima belum memiliki token FCM" });
    }

    const keys = Object.keys(tokenMap);
    let terkirim = 0;
    const daftarError = [];

    const judulNotif = String(judul || "NgobrolYuk");
    const isiNotif = String(isi || "Pesan baru masuk");
    const tagNotif = "ngobrolyuk-" + String(targetId || "umum");

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const entry = tokenMap[k];
      if (!entry || !entry.token) continue;

      const fcmPayload = {
        message: {
          token: entry.token,
          notification: {
            title: judulNotif,
            body: isiNotif
          },
          data: {
            judul: judulNotif,
            isi: isiNotif,
            targetId: String(targetId || ""),
            targetTipe: String(targetTipe || "pribadi"),
            nomorPenerima: String(nomorTujuan),
            namaPenerima: String(namaPenerima || nomorTujuan)
          },
          android: {
            priority: "high",
            ttl: "86400s",
            notification: {
              sound: "default",
              tag: tagNotif
            }
          },
          webpush: {
            headers: {
              Urgency: "high",
              TTL: "86400"
            },
            notification: {
              title: judulNotif,
              body: isiNotif,
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              tag: tagNotif,
              renotify: true,
              requireInteraction: true,
              vibrate: [250, 100, 250, 100, 250],
              actions: [
                { action: "balas", title: "Balas" },
                { action: "tandai_dibaca", title: "Tandai Dibaca" }
              ]
            }
          },
          apns: {
            headers: {
              "apns-priority": "10",
              "apns-push-type": "alert"
            },
            payload: {
              aps: {
                alert: {
                  title: judulNotif,
                  body: isiNotif
                },
                sound: "default",
                "content-available": 1
              }
            }
          }
        }
      };

      const fcmRes = await fetch(
        `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(fcmPayload)
        }
      );

      if (fcmRes.ok) {
        terkirim++;
      } else {
        const errText = await fcmRes.text();
        daftarError.push({ status: fcmRes.status, detail: errText });
        if (fcmRes.status === 404 || errText.includes("UNREGISTERED") || errText.includes("not a valid FCM registration token")) {
          await fetch(`${dbBase}/fcm_tokens/${encodeURIComponent(nomorTujuan)}/${encodeURIComponent(k)}.json?access_token=${accessToken}`, {
            method: "DELETE"
          });
        }
      }
    }

    return res.status(200).json({ ok: true, sent: terkirim, totalToken: keys.length, errors: daftarError });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
