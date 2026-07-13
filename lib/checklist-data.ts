export type Category = 'pagi' | 'siang' | 'malam' | 'sepanjang_hari'

export const CATEGORY_ORDER: Category[] = ['pagi', 'siang', 'malam', 'sepanjang_hari']

export const CATEGORY_LABEL: Record<Category, string> = {
  pagi: 'Pagi',
  siang: 'Siang',
  malam: 'Malam',
  sepanjang_hari: 'Sepanjang Hari',
}

export interface SeedItem {
  label: string
  category: Category
  anchor?: boolean
}

export const SEED_ITEMS: SeedItem[] = [
  { label: "Bangun subuh, sholat subuh tepat waktu — no ketiduran lagi", category: "pagi", anchor: true },
  { label: "Air putih 1 gelas penuh sebelum pegang HP", category: "pagi" },
  { label: "Kena matahari pagi 5–10 menit (energi + circadian)", category: "pagi" },
  { label: "Gerak 20–30 menit: workout / lari / kalistenik", category: "pagi", anchor: true },
  { label: "30 menit pertama no scroll — isi otak lo, bukan algoritma", category: "pagi" },
  { label: "Skincare pagi + sunscreen — kunci glow, jangan skip", category: "pagi" },
  { label: "1 deep work block 90 menit — full fokus, notif mati", category: "siang", anchor: true },
  { label: "Beresin 1 task penting AXA sampai kelar", category: "siang" },
  { label: "Progress ChronoTask / RagamSpace + commit hari ini", category: "siang" },
  { label: "Posting 1 konten / draft 1 ide masuk pipeline", category: "siang" },
  { label: "Engage 15 menit: bales komen & DM, rawat komunitas", category: "siang" },
  { label: "Skincare malam", category: "malam" },
  { label: "Review hari + tentuin 1–3 prioritas besok", category: "malam" },
  { label: "No layar 30 menit sebelum tidur", category: "malam" },
  { label: "Tidur 7 jam, sebelum jam 11 — recovery = fokus + glow", category: "malam", anchor: true },
  { label: "Journaling 3 baris: 1 syukur, 1 prioritas, 1 perbaikan", category: "sepanjang_hari" },
  { label: "Baca 10 halaman buku (buku beneran, bukan thread)", category: "sepanjang_hari" },
  { label: "Pelajari 1 hal teknikal baru / improve 1%", category: "sepanjang_hari" },
  { label: "Makan real food, protein cukup, rem gula & gorengan", category: "sepanjang_hari" },
  { label: "Air putih total 2–3 liter hari ini", category: "sepanjang_hari" },
  { label: "Catat semua pengeluaran hari ini", category: "sepanjang_hari" },
  { label: "Bayar diri sendiri dulu: sisihin buat tabungan / dana darurat", category: "sepanjang_hari" },
  { label: "1 langkah kecil naikin income (produk / konten / klien)", category: "sepanjang_hari" },
  { label: "Sholat 5 waktu lengkap, usahain tepat waktu", category: "sepanjang_hari", anchor: true },
  { label: "Quality time sama Caca 20 menit — HP ditaruh, beneran hadir", category: "sepanjang_hari" },
]

export const toDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

export const todayStr = () => toDateStr(new Date())
