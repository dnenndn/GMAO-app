-- STEP 11 (the app's own users) - run in SSMS once. Only touches GMAO_APP.
-- Each row is somebody allowed to log in to the mobile app, with his own password
-- (stored hashed, never readable). desktop_id is the person's id in GMAO_NGES.utilisateur:
-- it keeps every existing link working (BSM, DI, DA... are recorded under that id).
-- pwd_hash NULL = no password yet: the person chooses one at his first connection.
USE GMAO_APP;
GO
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'app_user')
BEGIN
    CREATE TABLE app_user (
        desktop_id  INT           NOT NULL,
        login       NVARCHAR(100) NOT NULL,
        fonction    NVARCHAR(60)  NOT NULL,
        pwd_hash    NVARCHAR(100) NULL,
        actif       BIT           NOT NULL DEFAULT 1,
        shadow      BIT           NOT NULL DEFAULT 0,   -- 1 = placeholder row created in utilisateur by the app
        created_by  INT           NULL,
        created_at  DATETIME      NOT NULL DEFAULT GETDATE(),
        pwd_set_at  DATETIME      NULL,
        last_login  DATETIME      NULL,
        CONSTRAINT PK_app_user PRIMARY KEY (desktop_id),
        CONSTRAINT UQ_app_user_login UNIQUE (login)
    );
END;
GO
