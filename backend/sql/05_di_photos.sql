-- STEP 5 (photos on breakdown requests) - run in SSMS once.
-- Only touches the small GMAO_APP database. Nothing is added to GMAO_NGES.
USE GMAO_APP;
GO
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_di_photo')
BEGIN
    CREATE TABLE app_di_photo (
        id INT IDENTITY(1,1) PRIMARY KEY,
        id_di INT NOT NULL,               -- demande_intervention.id (GMAO_NGES)
        id_user INT NOT NULL,             -- who added it
        data VARBINARY(MAX) NOT NULL,     -- JPEG, already shrunk by the phone
        created_at DATETIME NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX IX_app_di_photo_di ON app_di_photo (id_di);
END;
GO
