import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import ExcelJS from 'exceljs';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Init Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Init Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Init Anthropic
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Multer
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// JWT Middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nom, cabinet } = req.body;
    const password_hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase
      .from('users').insert({ email, password_hash, nom, cabinet }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    const token = jwt.sign({ id: data.id, email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: data.id, email, nom, cabinet } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user || !await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email, nom: user.nom, cabinet: user.cabinet } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload & Process Invoice
app.post('/api/invoices/upload', authMiddleware, upload.array('files', 10), async (req, res) => {
  const results = [];
  for (const file of req.files) {
    const { data: inv } = await supabase.from('invoices')
      .insert({ user_id: req.user.id, filename: file.originalname, status: 'processing' })
      .select().single();

    // Upload to Cloudinary
    const b64 = Buffer.from(file.buffer).toString('base64');
    const dataUri = `data:${file.mimetype};base64,${b64}`;
    const uploaded = await cloudinary.uploader.upload(dataUri, { folder: 'comptaai' });
    
    // Extract with AI
    processInvoice(inv.id, file, uploaded.secure_url, req.user.id);
    results.push({ id: inv.id, status: 'processing' });
  }
  res.json({ uploaded: results.length, results });
});

async function processInvoice(id, file, fileUrl, userId) {
  try {
    const b64 = Buffer.from(file.buffer).toString('base64');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: file.mimetype, data: b64 }
        }, {
          type: 'text',
          text: 'Extract from this Moroccan invoice and return JSON only: { "client_nom": "", "ice": "", "if_number": "", "date": "YYYY-MM-DD", "ht": 0, "tva_rate": 20, "tva": 0, "ttc": 0, "type": "client" }'
        }]
      }]
    });

    const extracted = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    await supabase.from('invoices').update({
      ...extracted, file_url: fileUrl, status: 'completed'
    }).eq('id', id);
  } catch (e) {
    await supabase.from('invoices').update({ status: 'error', error_message: e.message }).eq('id', id);
  }
}

// Get Invoices
app.get('/api/invoices', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('invoices')
    .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

// Delete Invoice
app.delete('/api/invoices/:id', authMiddleware, async (req, res) => {
  await supabase.from('invoices').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// Dashboard Stats
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  const { data: invoices } = await supabase.from('invoices')
    .select('*').eq('user_id', req.user.id).eq('status', 'completed');
  const stats = {
    total: invoices?.length || 0,
    tva_collectee: invoices?.filter(i => i.type === 'client').reduce((s, i) => s + Number(i.tva || 0), 0) || 0,
    tva_deductible: invoices?.filter(i => i.type === 'fournisseur').reduce((s, i) => s + Number(i.tva || 0), 0) || 0,
  };
  stats.tva_nette = stats.tva_collectee - stats.tva_deductible;
  res.json(stats);
});

// Export CSV
app.get('/api/export/csv', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('invoices').select('*').eq('user_id', req.user.id).eq('status', 'completed');
  const rows = [['Client/Fournisseur','ICE','IF','Date','HT','TVA%','TVA','TTC','Type']];
  data?.forEach(i => rows.push([i.client_nom,i.ice,i.if_number,i.date,i.ht,i.tva_rate,i.tva,i.ttc,i.type]));
  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=comptaai_export.csv');
  res.send('\uFEFF' + csv);
});

// Export Excel
app.get('/api/export/excel', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('invoices').select('*').eq('user_id', req.user.id).eq('status', 'completed');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Factures');
  ws.addRow(['Client/Fournisseur','ICE','IF','Date','HT (MAD)','TVA %','TVA (MAD)','TTC (MAD)','Type']);
  data?.forEach(i => ws.addRow([i.client_nom,i.ice,i.if_number,i.date,i.ht,i.tva_rate,i.tva,i.ttc,i.type]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=comptaai_export.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'ComptaAI' }));
app.listen(PORT, () => console.log(`ComptaAI backend running on port ${PORT}`));
