// api/check-payment.js
const axios = require("axios");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const BAKONG_BASE_URL =
      process.env.BAKONG_BASE_URL || "https://api-bakong.nbc.gov.kh";
    const BAKONG_TOKEN = process.env.BAKONG_TOKEN || "";

    const { md5 } = req.body || {};
    if (!md5) return res.status(400).json({ ok: false, error: "Missing md5" });

    if (!BAKONG_TOKEN) {
      return res.json({
        ok: true,
        status: "PENDING",
        note: "BAKONG_TOKEN not set; live payment check disabled",
      });
    }

    const resp = await axios.post(
      `${BAKONG_BASE_URL}/v1/check_transaction_by_md5`,
      { md5 },
      {
        headers: {
          Authorization: `Bearer ${BAKONG_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const data = resp.data;

    // Adjust logic based on Bakong response structure you get
    const paid = !!(data && data.responseCode === 0 && data.data);

    return res.json({
      ok: true,
      status: paid ? "PAID" : "PENDING",
      raw: paid ? undefined : undefined, // keep clean
    });
  } catch (err) {
    console.error("check-payment error:", err.response?.data || err.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
