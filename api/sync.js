export default async function handler(req, res) {
  // These names match the ones Vercel created for you automatically
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (req.method === 'POST') {
    // This SAVES your data to Upstash
    await fetch(`${url}/set/portfolio_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(req.body)
    });
    return res.status(200).json({ success: true });
  } else {
    // This GETS your data from Upstash
    const response = await fetch(`${url}/get/portfolio_data`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json();
    return res.status(200).json(result);
  }
}
