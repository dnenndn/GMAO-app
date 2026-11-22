# Gestion de Feuillard: reverse-engineering report

Source: `Setup_feuillard_20-11-2026.rar` (ClickOnce installer, published 20 Nov 2026).

## 1. What it is

| | |
|---|---|
| Product | **Gestion de Feuillard** (strapping-band management), ClickOnce version **1.0.0.21** |
| Assembly | `Annexe_GMAO` (an "annex" of a GMAO / CMMS), copyright "HP Inc. 2020" (Visual Studio default from the dev PC) |
| Author shown in the UI | "Hadj Mohamed Hamza" (default label, replaced by the logged-in user name) |
| Tech | C# WinForms, .NET Framework 4.7.2, x86 |
| Database | Microsoft SQL Server, database `feuillard`, accessed directly with `System.Data.SqlClient` (no server/API layer) |
| Libraries | iTextSharp (PDF quality report), Excel COM Interop (export), System.Windows.Forms.DataVisualization (charts), Microsoft.Data.Tools.Components (bundled, essentially unused) |
| Size | about 22,000 lines of decompiled C#, 23 forms |

**Domain:** a brick and plaster plant (packaging units **B12, B8, Hourdi, Platrière**). The app follows steel or plastic *feuillard* (strapping coils) from supplier receipt, through incoming quality control, to the warehouse stock. From there it tracks issues to shift team leaders, consumption per packaging unit and shift, returns and scrap, and returns to the supplier. It also records waste-cause analysis (Ishikawa 5M) and strapping-machine downtime.

Archive note: `fr/Microsoft.Data.Tools.Components.resources.dll.deploy` is truncated in the RAR (0 bytes after extraction). It is a French satellite resource of an unused library and does not affect the analysis.

## 2. Architecture

```
Program.Main ─► Form1 (shell: header Panel1, left menu Panel2, content panel3)
                 │
                 ├─ Login panel ─► SELECT id, statut FROM utilisateur WHERE nom=@ AND mot_de_passe=@
                 │                 sets static Login.id_user / Login.stat_user
                 └─ Menu_feuillard (10 icons) ─► each opens a Form embedded in panel3 (TopLevel=false)
```

* **`bd`**: a single class holding a `SqlConnection` with a **hard-coded connection string** (`Data Source=192.168.1.188; database=feuillard; User Id=sa; Password=…`). Each form creates `new bd()` and opens and closes it around each query.
* **`Fonction`**: helpers (strip spaces, `isnumeric`, `is_reel`, DataGridView styling in purple `#6F6DD8`, and linear searches in lists).
* Global state lives in static fields (`Login.id_user`, `Login.stat_user`, `Entree_feuillard.id_qualite`, `Historique_production.article2`, …).
* No transactions, no ORM, no stored procedures, no logging. All SQL is inline and parameterized.

## 3. Screens and features (menu icon → form)

| Menu | Form | What it does |
|---|---|---|
| Entrée | `Entree_feuillard` (+ `Ajouter_feuillard` dialog) | Goods receipt: date, supplier, article, quantity. Inserts `entre_magasin` and **stock +qt**. Filters by date, storekeeper, supplier and article. Pie charts % by article, % by supplier, monthly totals. A delete action reverses the stock. A "Contrôle qualité" link opens QC for the selected receipt. |
| (from Entrée) | `controle_qualite` | Incoming QC per receipt. Grid of coils with weight, thickness, width, crack (Oui/Non) and colour (Bon/Mauvais). Each value is checked live against the article's min/max tolerances (cell turns red or green). Final decision text goes to `qual_general`. Photos go to `photo_qualite` (viewed in `photo`). **PDF export** "Rapport de contrôle qualité feuillard" with iTextSharp. |
| Sortie | `Stock_feuillard` | The *issue* screen, despite its name: a stock-on-hand table per article, plus a "Lancer Sortie Feuillard" form (date, shift Jour/Soir/Nuit, team leader, packaging unit, article, qty). Inserts `sortie_feuillard` and **stock −qt**. |
| Stock | `sortie_feuillard` | Issue history with filters and a delete action (reverses stock +qt). |
| Retour | `retour_feuillard` | Returns from production with a type. **Only "Bon état" re-enters stock**; other types count as scrap. Includes history, stats per unit and per team leader. |
| Production | `Production` (+ `cause_encercleuse`) | Shift production record: date, shift, team leader, packaging unit (single or mixed, e.g. "B12 & Hourdi"), wagons, pallets, coils used (1 or 2 articles). Has an **Ishikawa diagram** where causes of the effect "Déchet feuillard" are ticked per 5M category (Machine, Main d'œuvre, Matière, Méthode, Milieu). For machine causes, a sub-form records per strapping machine (line A/B) the frequency and downtime `hh:mm:ss`. **Production does not change stock.** |
| Statistique | `Historique_production` (+ `Affichage_production`, `affichage_rapport_total`) | Production history and delete, strap consumption per packaging unit, % waste per team leader, and a "Rapport Total" that reconciles issued, returned and consumed coils (converted with `qt_meter`) per team leader, unit and article. |
| Tableau de bord | `tableau_bord` | KPIs over a date range: Bobine/Palette, Bobine/Wagon and Palette/Wagon ratios per unit, a team-leader report, Ishikawa cause frequency, machine failures (frequency and total duration). Excel export. |
| Retour fournisseur | `Sortie_fournisseur` | Return to supplier. Inserts `sortie_fournisseur` and **stock −qt**. |
| Paramètre | `paramètre_feuillard` | CRUD for articles (capacity in metres, weight, thickness and width tolerances), suppliers, team leaders, packaging units, strapping machines (unit and line) and Ishikawa causes (type). Creating an article also creates its `stock_feuillard` row. |
| Utilisateur | `utilisateur` | CRUD for users (name, password, status). |

### Roles (UI-only)

| Status | Hidden menu entries |
|---|---|
| Administrateur | none |
| Methode | Paramètre, Utilisateur |
| Magasinier, Achat | Paramètre, Production, Statistique, Utilisateur, Tableau de bord |

Roles only **hide icons** in `Menu_feuillard_Load`. Nothing is enforced at the database level, and every client connects as `sa`.

## 4. Data model

The full reconstructed DDL is in [`schema.sql`](schema.sql) (16 tables). Relationships:

```
fournisseur ─┐                 ┌─ receptionniste (chef d'équipe)
article_feuillard ─ stock_feuillard        destination (unité d'emballage) ─ encercleuse
   │                                          │
   ├─ entre_magasin ─ qualite / qual_general / photo_qualite
   ├─ sortie_feuillard ───────────────────────┤
   ├─ retour_feuillard ───────────────────────┤
   ├─ sortie_fournisseur                      │
   └─ production (id_article, id2_article) ───┘─ ishikawa, cause_encercleuse ─ encercleuse
utilisateur (id_magasinier on every movement)   cause (catalogue used by ishikawa)
```

### Stock rules

| Event | Stock effect | Undone on delete? |
|---|---|---|
| Receipt (`entre_magasin`) | + qt | yes (− qt) |
| Issue (`sortie_feuillard`) | − qt | yes (+ qt) |
| Return, type "Bon état" (`retour_feuillard`) | + qt | **no**, bug |
| Return, other type | none | n/a |
| Supplier return (`sortie_fournisseur`) | − qt | **no**, bug |
| Production record | none | n/a |

Stock is updated *by article designation* (`… WHERE article_feuillard.designation = @t`), not by id.

## 5. Findings

### Security (critical)
1. **Hard-coded `sa` credentials** in `bd.cs`, sent to every workstation inside the exe. Anyone with the installer can decompile it in seconds and get full sysadmin access to the SQL Server at 192.168.1.188. That access covers all databases on the instance and potentially OS commands through `xp_cmdshell`. **Change the `sa` password now** and create a least-privilege SQL login.
2. **Plain-text passwords** in `utilisateur.mot_de_passe`, and the users screen shows them.
3. **Client-side authorization only.** A Magasinier user, or anyone with the connection string, can do everything.
4. Positive: all queries use parameters, and no SQL injection was found.

### Data integrity
5. Deleting a return or a supplier return leaves the stock wrong (see the table above).
6. No transactions. A movement insert followed by a stock update can half-fail. Deleting a production record removes `ishikawa` rows but **leaves `cause_encercleuse` orphaned**. Deleting an article, supplier, unit, etc. leaves orphaned movements, which then disappear from INNER JOIN reports.
7. Stock is keyed by designation, so renaming or duplicating designations breaks it.
8. Numbers are passed as text into `SqlDbType.Real` and parsed with the current culture (decimal comma or point issues).

### Robustness / portability
9. The PDF is written to a hard-coded path `C://Users//HP//Desktop//pdf_feuillard//…`. It fails on any other PC or user.
10. Excel export needs Microsoft Excel installed (COM Interop).
11. Massive code duplication: four near-identical `insert into production` variants, one filter query per combination in `Entree_feuillard`.

## 6. Reusing this in GMAO-app

To port this module into the GMAO web or Android app:
* Re-create the tables from `schema.sql` behind the existing `backend/` API. Never let clients connect to SQL directly.
* Add FKs with `ON DELETE` rules, wrap each movement and its stock update in one transaction, or derive stock as `SUM(receipts) − SUM(issues) + SUM(good returns) − SUM(supplier returns)` instead of storing it.
* Map the roles onto GMAO-app's existing user and rights system.
* Move the article tolerances and QC rules to the backend, and store QC photos as files.

## 7. How this was produced

```
unar  Setup_feuillard_20-11-2026.rar
ilspycmd -p "Gestion de Feuillard.exe"     # ILSpy 8.2, full C# project
```

The decompiled project is kept outside the repo on purpose because it contains the live credentials.
