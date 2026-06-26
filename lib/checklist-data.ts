export interface ChecklistItem {
  id: string
  label: string
  anchor?: boolean
}

export interface ChecklistSection {
  title: string
  clock: string
  items: ChecklistItem[]
}

export const DATA: ChecklistSection[] = [
  { title: "Subuh & Pagi", clock: "04:30–07:00", items: [
    { id: "subuh",    label: "Bangun subuh, sholat subuh tepat waktu — no ketiduran lagi", anchor: true },
    { id: "air1",     label: "Air putih 1 gelas penuh sebelum pegang HP" },
    { id: "sun",      label: "Kena matahari pagi 5–10 menit (energi + circadian)" },
    { id: "gerak",    label: "Gerak 20–30 menit: workout / lari / kalistenik", anchor: true },
    { id: "noscroll", label: "30 menit pertama no scroll — isi otak lo, bukan algoritma" },
  ]},
  { title: "Otak & Diri", clock: "sepanjang hari", items: [
    { id: "jurnal",  label: "Journaling 3 baris: 1 syukur, 1 prioritas, 1 perbaikan" },
    { id: "baca",    label: "Baca 10 halaman buku (buku beneran, bukan thread)" },
    { id: "belajar", label: "Pelajari 1 hal teknikal baru / improve 1%" },
  ]},
  { title: "Tubuh & Glow", clock: "pagi & malam", items: [
    { id: "skinpagi",  label: "Skincare pagi + sunscreen — kunci glow, jangan skip" },
    { id: "makan",     label: "Makan real food, protein cukup, rem gula & gorengan" },
    { id: "air2",      label: "Air putih total 2–3 liter hari ini" },
    { id: "skinmalam", label: "Skincare malam" },
  ]},
  { title: "Kerja & Build", clock: "deep work", items: [
    { id: "deep",  label: "1 deep work block 90 menit — full fokus, notif mati", anchor: true },
    { id: "axa",   label: "Beresin 1 task penting AXA sampai kelar" },
    { id: "build", label: "Progress ChronoTask / RagamSpace + commit hari ini" },
  ]},
  { title: "Cuan", clock: "5 menit", items: [
    { id: "catat",  label: "Catat semua pengeluaran hari ini" },
    { id: "nabung", label: "Bayar diri sendiri dulu: sisihin buat tabungan / dana darurat" },
    { id: "income", label: "1 langkah kecil naikin income (produk / konten / klien)" },
  ]},
  { title: "Konten & Komunitas", clock: "15–30 menit", items: [
    { id: "posting", label: "Posting 1 konten / draft 1 ide masuk pipeline" },
    { id: "engage",  label: "Engage 15 menit: bales komen & DM, rawat komunitas" },
  ]},
  { title: "Spiritual & Pasangan", clock: "setiap waktu", items: [
    { id: "sholat5", label: "Sholat 5 waktu lengkap, usahain tepat waktu", anchor: true },
    { id: "caca",    label: "Quality time sama Caca 20 menit — HP ditaruh, beneran hadir" },
  ]},
  { title: "Malam & Recovery", clock: "21:00–23:00", items: [
    { id: "review",   label: "Review hari + tentuin 1–3 prioritas besok" },
    { id: "nolayar",  label: "No layar 30 menit sebelum tidur" },
    { id: "tidur",    label: "Tidur 7 jam, sebelum jam 11 — recovery = fokus + glow", anchor: true },
  ]},
]

export const TOTAL      = DATA.flatMap(s => s.items).length          // 25
export const ANCHOR_IDS = DATA.flatMap(s => s.items.filter(i => i.anchor).map(i => i.id))  // 5

export const toDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

export const todayStr = () => toDateStr(new Date())