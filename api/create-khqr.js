// api/create-khqr.js
const QRCode = require("qrcode");
const { BakongKHQR, khqrData, IndividualInfo } = require("bakong-khqr");

function generateOrderId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `CAFE-${y}${m}${d}${hh}${mm}${ss}-${rand}`;
}

module.exports = async function handler(req, res) {
  // CORS (optional if same domain)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const BAKONG_ACCOUNT_ID = process.env.BAKONG_ACCOUNT_ID || "";
    const MERCHANT_NAME = process.env.MERCHANT_NAME || "CVG Cafe";
    const MERCHANT_CITY = process.env.MERCHANT_CITY || "Phnom Penh";
    const DEFAULT_CURRENCY = (process.env.CURRENCY || "USD").toUpperCase();

    let { amount, currency } = req.body || {};
    amount = Number(amount || 0);

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount (> 0)" });
    }

    if (!BAKONG_ACCOUNT_ID || !BAKONG_ACCOUNT_ID.includes("@")) {
      return res.status(500).json({
        ok: false,
        error: "BAKONG_ACCOUNT_ID not set correctly (e.g. yourid@aclb)",
      });
    }

    const currencyCode = (currency || DEFAULT_CURRENCY).toUpperCase();
    const khqrCurrency =
      currencyCode === "KHR" ? khqrData.currency.khr : khqrData.currency.usd;

    const orderId = generateOrderId();
    const expirationTimestamp = Date.now() + 10 * 60 * 1000;

    const optionalData = {
      currency: khqrCurrency,
      amount,
      merchantCategoryCode: "5999",
      billNumber: orderId,
      purposeOfTransaction: "Cafe order",
      storeLabel: MERCHANT_NAME,
      expirationTimestamp,
    };

    const individualInfo = new IndividualInfo(
      BAKONG_ACCOUNT_ID,
      MERCHANT_NAME,
      MERCHANT_CITY,
      optionalData
    );

    const khqr = new BakongKHQR();
    const result = khqr.generateIndividual(individualInfo);

    if (!result || result.status.code !== 0 || !result.data) {
      return res.status(500).json({
        ok: false,
        error: "Failed to generate KHQR",
        detail: result?.status?.message || null,
      });
    }

    const qrString = result.data.qr;
    const md5 = result.data.md5;

    const qrImage = await QRCode.toDataURL(qrString, { width: 320, margin: 2 });

    return res.json({
      ok: true,
      orderId,
      amount,
      currency: currencyCode,
      md5,      // ✅ IMPORTANT: return md5 (no in-memory store needed)
      qrImage,
    });
  } catch (err) {
    console.error("create-khqr error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
