-- Reconstructed schema of the "feuillard" SQL Server database used by
-- "Gestion de Feuillard" v1.0.0.21 (assembly Annexe_GMAO).
-- Rebuilt from every SQL statement and parameter type in the decompiled code.
-- Column types are inferred (SqlDbType of the parameters); lengths, NULL-ability,
-- defaults and constraints are NOT in the binary and are best guesses.
-- No foreign keys are assumed by the app (it deletes parents without cascading).

CREATE TABLE utilisateur (
    id            INT IDENTITY PRIMARY KEY,
    nom           VARCHAR(100),
    mot_de_passe  VARCHAR(100),          -- stored in PLAIN TEXT
    statut        VARCHAR(50)            -- 'Administrateur' | 'Magasinier' | 'Achat' | 'Methode'
);

-- Reference data (managed in the "Paramètre" screen)
CREATE TABLE fournisseur    (id INT IDENTITY PRIMARY KEY, nom VARCHAR(100));  -- suppliers
CREATE TABLE receptionniste (id INT IDENTITY PRIMARY KEY, nom VARCHAR(100));  -- "Chef d'équipe" (team leader receiving the strap)
CREATE TABLE destination    (id INT IDENTITY PRIMARY KEY, nom VARCHAR(100));  -- "Unité d'emballage": B12, B8, Hourdi, Platrière, ...

CREATE TABLE article_feuillard (          -- strapping-band item + its quality tolerances
    id             INT IDENTITY PRIMARY KEY,
    designation    VARCHAR(100),
    qt_meter       REAL,                  -- capacity, metres per coil
    min_poids      REAL, max_poids      REAL,   -- kg
    min_epaisseur  REAL, max_epaisseur  REAL,   -- mm
    min_largeur    REAL, max_largeur    REAL    -- mm
);

CREATE TABLE stock_feuillard (            -- one row per article, running balance
    id          INT IDENTITY PRIMARY KEY,
    id_article  INT,                      -- -> article_feuillard.id
    qt          REAL
);

CREATE TABLE encercleuse (                -- strapping machine ("Cercleuse")
    id           INT IDENTITY PRIMARY KEY,
    designation  VARCHAR(100),
    id_unite     INT,                     -- -> destination.id
    ligne        VARCHAR(20)              -- 'Ligne A' | 'Ligne B'
);

CREATE TABLE cause (                      -- Ishikawa cause catalogue
    id           INT IDENTITY PRIMARY KEY,
    designation  VARCHAR(200),
    type         VARCHAR(50)              -- 'Machine' | 'Main_Ouevre' | 'Matiere' | 'Methode' | 'Milieu'
);

-- Stock movements
CREATE TABLE entre_magasin (              -- goods receipt (stock +)
    id              INT IDENTITY PRIMARY KEY,
    date_entre      DATE,
    id_magasinier   INT,                  -- -> utilisateur.id
    id_article      INT,
    qt              REAL,
    id_fournisseur  INT
);

CREATE TABLE sortie_feuillard (           -- issue to production team (stock -)
    id                 INT IDENTITY PRIMARY KEY,
    date_sortie        DATE,
    id_receptionniste  INT,
    id_destination     INT,
    id_magasinier      INT,
    id_article         INT,
    poste              VARCHAR(20),       -- shift: 'Jour' | 'Soir' | 'Nuit'
    qt                 REAL
);

CREATE TABLE retour_feuillard (           -- return from production (stock + only if good)
    id                 INT IDENTITY PRIMARY KEY,
    date_retour        DATE,
    id_receptionniste  INT,
    id_destination     INT,
    id_magasinier      INT,
    id_article         INT,
    poste              VARCHAR(20),
    qt                 REAL,
    type               VARCHAR(50)        -- 'Bon état' re-enters stock; anything else = scrap
);

CREATE TABLE sortie_fournisseur (         -- return to supplier (stock -)
    id              INT IDENTITY PRIMARY KEY,
    date_sortie     DATE,
    id_article      INT,
    id_fournisseur  INT,
    id_magasinier   INT,
    qt              REAL
);

-- Incoming quality control (per receipt)
CREATE TABLE qualite (                    -- one row per coil measured
    id             INT IDENTITY PRIMARY KEY,
    id_entre       INT,                   -- -> entre_magasin.id
    date_q         DATE,
    id_magasinier  INT,
    epaisseur      REAL,
    largeur        REAL,
    fissure        VARCHAR(10),           -- 'Oui' | 'Non'
    couleur        VARCHAR(20),           -- 'Bon' | 'Mauvais'
    observation    VARCHAR(500),
    poids          REAL
);
CREATE TABLE qual_general  (id INT IDENTITY PRIMARY KEY, id_entre INT, observation VARCHAR(1000)); -- final decision
CREATE TABLE photo_qualite (id INT IDENTITY PRIMARY KEY, id_entre INT, taswira IMAGE);            -- photo (VARBINARY(MAX) today)

-- Production / consumption
CREATE TABLE production (
    id                 INT IDENTITY PRIMARY KEY,
    date_production    DATE,
    id_receptionniste  INT,
    id_destination     INT,
    id_article         INT,
    id2_article        INT NULL,          -- second article on mixed units ("B12 & B8", ...)
    poste              VARCHAR(20),
    nbre_wagon         REAL,
    nbre_palette       REAL,
    brique             VARCHAR(50),       -- brick type produced
    nbre_bobine        REAL,              -- coils consumed (article 1)
    nbre_bobine_2      REAL NULL,         -- coils consumed (article 2)
    wagon_h            REAL NULL,         -- wagons of 2nd brick type ("Br_2")
    palette_h          REAL NULL          -- pallets of 2nd brick type
);

CREATE TABLE ishikawa (                   -- causes of strap waste for a production record
    id             INT IDENTITY PRIMARY KEY,
    id_production  INT,
    designation    VARCHAR(200),
    type           VARCHAR(50)
);

CREATE TABLE cause_encercleuse (          -- machine stoppages for a production record
    id              INT IDENTITY PRIMARY KEY,
    id_production   INT,
    id_encercleuse  INT,
    cause_machine   VARCHAR(200),
    frequence       REAL,
    duree           VARCHAR(20)           -- 'hh:mm:ss' stored as text
);
