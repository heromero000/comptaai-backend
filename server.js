const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer with Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'comptaai',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
  },
});
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Anthropic
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email).single();

    if (existing) return res.status(409).json({ error: 'Email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ email, password_hash: passwordHash, name: name || '', company: company || '' })
      .select().single();

    if (error) throw error;

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, company: user.company } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users').select('*').eq('email', email).single();

    if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, company: user.company } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from('users').select('id,email,name,company').eq('id', req.user.userId).single();
  res.json({ user });
});

// GET /api/invoices
app.get('/api/invoices', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('invoices').select('*').eq('user_id', req.user.userId).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ invoices: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/upload
app.post('/api/invoices/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { data: invoice, error } = await supabase
      .from('invoices')
      .insert({
        user_id: req.user.userId,
        filename: req.file.originalname,
        file_url: req.file.path,
        cloudinary_public_id: req.file.filename,
        status: 'uploaded',
      }).select().single();

    if (error) throw error;
    res.json({ invoice });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/invoices/:id/process
app.post('/api/invoices/:id/process', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: invoice, error: fetchErr } = await supabase
      .from('invoices').select('*').eq('id', id).eq('user_id', req.user.userId).single();

    if (fetchErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    await supabase.from('invoices').update({ status: 'processing' }).eq('id', id);

    // Fetch image
    const imageResp = await fetch(invoice.file_url);
    const imageBuffer = await imageResp.arrayBuffer();
    const base64 = Buffer.from(imageBuffer).toString('base64');
    const mediaType = imageResp.headers.get('content-type') || 'image/jpeg';

    // Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        }, {
          type: 'text',
          text: 'Extract invoice data from this image. Return JSON with: supplier, invoice_number, date (YYYY-MM-DD), due_date, subtotal (number), tva_rate (7/10/14/20), tva_amount (number), total (number), type (vente/achat), description. Return only valid JSON.',
        }],
      }],
    });

    let extracted = {};
    try {
      const jsonText = message.content[0].text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      extracted = JSON.parse(jsonText);
    } catch {
      extracted = { description: message.content[0].text };
    }

    const tvaRate = extracted.tva_rate || 20;
    const total = extracted.total || 0;
    const subtotal = extracted.subtotal || (total / (1 + tvaRate / 100));
    const tvaAmount = extracted.tva_amount || (total - subtotal);

    const { data: updated, error: updateErr } = await supabase
      .from('invoices')
      .update({
        status: 'processed',
        supplier: extracted.supplier,
        invoice_number: extracted.invoice_number,
        date: extracted.date,
        due_date: extracted.due_date,
        subtotal, tva_rate: tvaRate, tva_amount: tvaAmount, total,
        type: extracted.type || 'achat',
        description: extracted.description,
        extracted_data: extracted,
      }).eq('id', id).select().single();

    if (updateErr) throw updateErr;
    res.json({ invoice: updated });
  } catch (err) {
    console.error('Process error:', err);
    await supabase.from('invoices').update({ status: 'error', error_message: err.message }).eq('id', req.params.id);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invoices/:id
app.delete('/api/invoices/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: invoice } = await supabase.from('invoices').select('cloudinary_public_id').eq('id', id).eq('user_id', req.user.userId).single();
    if (invoice && invoice.cloudinary_public_id) {
      await cloudinary.uploader.destroy(invoice.cloudinary_public_id);
    }
    await supabase.from('invoices').delete().eq('id', id).eq('user_id', req.user.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/csv
app.get('/api/export/csv', authMiddleware, async (req, res) => {
  try {
    const { data: invoices } = await supabase
      .from('invoices').select('*').eq('user_id', req.user.userId).eq('status', 'processed').order('date');

    const bom = '\uFEFF';
    const headers = 'Date;Fournisseur;N Facture;HT;TVA%;TVA MAD;TTC;Type;Description\n';
    const rows = (invoices || []).map(inv =>
      (inv.date || '') + ';' + (inv.supplier || '') + ';' + (inv.invoice_number || '') + ';' +
      (inv.subtotal || 0).toFixed(2) + ';' + (inv.tva_rate || 0) + '%;' +
      (inv.tva_amount || 0).toFixed(2) + ';' + (inv.total || 0).toFixed(2) + ';' +
      (inv.type || '') + ';' + (inv.description || '')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ComptaAI_Export.csv"');
    res.send(bom + headers + rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/excel
app.get('/api/export/excel', authMiddleware, async (req, res) => {
  try {
    const { data: invoices } = await supabase
      .from('invoices').select('*').eq('user_id', req.user.userId).eq('status', 'processed').order('date');

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ComptaAI';
    const ws = wb.addWorksheet('Factures');
    ws.addRow(['Date', 'Fournisseur', 'N Facture', 'HT (MAD)', 'TVA %', 'TVA (MAD)', 'TTC (MAD)', 'Type', 'Description']);
    ws.getRow(1).font = { bold: true };
    (invoices || []).forEach(inv => {
      ws.addRow([inv.date, inv.supplier, inv.invoice_number, inv.subtotal, inv.tva_rate ? inv.tva_rate + '%' : '', inv.tva_amount, inv.total, inv.type, inv.description]);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="ComptaAI_NT_COMPTA.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('ComptaAI API running on port ' + PORT));
module.exports = app;
