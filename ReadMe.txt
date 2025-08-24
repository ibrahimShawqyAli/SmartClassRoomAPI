/* 1) Create a SQL Server login (server-wide) */
CREATE LOGIN college_user
WITH PASSWORD = 'Str0ngP@ssw0rd!',
     CHECK_POLICY = ON,   -- enforce Windows password policy
     CHECK_EXPIRATION = OFF; -- optional: do not expire

/* 2) Switch to your database */
USE collegeDB;
GO

/* 3) Create a database user mapped to the login */
CREATE USER college_user FOR LOGIN college_user;

/* 4) Grant database roles/permissions */
-- If you want full rights on the DB (typical for dev):
ALTER ROLE db_owner ADD MEMBER college_user;

-- For production, you can use:
-- ALTER ROLE db_datareader ADD MEMBER college_user;
-- ALTER ROLE db_datawriter ADD MEMBER college_user;








-- Check login exists and status
SELECT name, is_disabled, LOGINPROPERTY(name,'IsLocked') AS is_locked
FROM sys.sql_logins
WHERE name = 'college_user';

-- Ensure enabled and unlocked; reset password explicitly
ALTER LOGIN college_user WITH PASSWORD = 'Str0ngP@ssw0rd!';
ALTER LOGIN college_user ENABLE;




// node -e "const bcrypt=require('bcryptjs');bcrypt.hash('123456',10).then(h=>console.log(h))"  for hash



/* 0) Create DB (if not exists) */
IF DB_ID(N'collegeDB') IS NULL
BEGIN
  CREATE DATABASE collegeDB;
END
GO
USE collegeDB;
GO

/* 1) USERS */
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    id                    INT IDENTITY(1,1) PRIMARY KEY,
    name                  NVARCHAR(100)      NOT NULL,
    email                 NVARCHAR(255)      NOT NULL UNIQUE,
    password_hash         VARCHAR(255)       NOT NULL, -- bcrypt hash
    department            NVARCHAR(100)      NULL,
    [level]               NVARCHAR(50)       NULL,
    [section]             NVARCHAR(50)       NULL,
    group_name            NVARCHAR(50)       NULL,
    role                  NVARCHAR(10)       NOT NULL CONSTRAINT CK_users_role CHECK (role IN ('student','teacher','admin')),
    force_password_change BIT                NOT NULL CONSTRAINT DF_users_forcepass DEFAULT(1),
    created_at            DATETIME2(0)       NOT NULL CONSTRAINT DF_users_created DEFAULT(SYSUTCDATETIME()),
    updated_at            DATETIME2(0)       NOT NULL CONSTRAINT DF_users_updated DEFAULT(SYSUTCDATETIME())
  );
END
GO

/* Trigger must be in its own batch */
IF OBJECT_ID(N'dbo.tr_users_updated_at', N'TR') IS NULL
EXEC('
CREATE TRIGGER dbo.tr_users_updated_at ON dbo.users
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE u SET updated_at = SYSUTCDATETIME()
  FROM dbo.users u
  INNER JOIN inserted i ON u.id = i.id;
END
');
GO

/* 2) DEVICES */
IF OBJECT_ID(N'dbo.devices', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.devices (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT            NOT NULL,
    udid       NVARCHAR(128)  NOT NULL UNIQUE,
    created_at DATETIME2(0)   NOT NULL CONSTRAINT DF_devices_created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT FK_devices_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX UX_devices_user ON dbo.devices(user_id);
END
GO

/* 3) LECTURES */
IF OBJECT_ID(N'dbo.lectures', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.lectures (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    name              NVARCHAR(200)    NOT NULL,
    place             NVARCHAR(100)    NOT NULL,
    day_of_week       TINYINT          NOT NULL,  -- 0=Sun..6=Sat
    start_time        TIME(0)          NOT NULL,
    duration_minutes  INT              NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 600),
    modulation_string NVARCHAR(128)    NOT NULL UNIQUE,
    created_by        INT              NOT NULL,
    created_at        DATETIME2(0)     NOT NULL CONSTRAINT DF_lectures_created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT CK_lectures_day CHECK (day_of_week BETWEEN 0 AND 6),
    CONSTRAINT FK_lectures_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id)
  );
  CREATE INDEX IX_lectures_day_time ON dbo.lectures(day_of_week, start_time);
END
GO

/* 4) LECTURE ASSIGNMENTS */
IF OBJECT_ID(N'dbo.lecture_assignments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.lecture_assignments (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    lecture_id  INT           NOT NULL,
    user_id     INT           NOT NULL,
    role        NVARCHAR(10)  NOT NULL CONSTRAINT CK_assign_role CHECK (role IN ('teacher','student')),
    assigned_at DATETIME2(0)  NOT NULL CONSTRAINT DF_assign_assigned DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT FK_assign_lecture FOREIGN KEY (lecture_id) REFERENCES dbo.lectures(id) ON DELETE CASCADE,
    CONSTRAINT FK_assign_user    FOREIGN KEY (user_id)    REFERENCES dbo.users(id)    ON DELETE CASCADE,
    CONSTRAINT UQ_assign UNIQUE (lecture_id, user_id)
  );
  CREATE INDEX IX_assign_lecture_role ON dbo.lecture_assignments(lecture_id, role);
  CREATE INDEX IX_assign_user_role    ON dbo.lecture_assignments(user_id, role);
END
GO

/* 5) LECTURE SESSIONS */
IF OBJECT_ID(N'dbo.lecture_sessions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.lecture_sessions (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    lecture_id          INT          NOT NULL,
    planned_date        DATE         NOT NULL,
    planned_start_time  TIME(0)      NOT NULL,
    planned_end_time    TIME(0)      NOT NULL,
    status              NVARCHAR(10) NOT NULL CONSTRAINT CK_sessions_status CHECK (status IN ('pending','started','ended','cancelled'))
                                    CONSTRAINT DF_sessions_status DEFAULT('pending'),
    started_at          DATETIME2(0) NULL,
    ended_at            DATETIME2(0) NULL,
    started_by          INT          NULL,
    CONSTRAINT FK_sessions_lecture   FOREIGN KEY (lecture_id) REFERENCES dbo.lectures(id) ON DELETE CASCADE,
    CONSTRAINT FK_sessions_startedby FOREIGN KEY (started_by) REFERENCES dbo.users(id),
    CONSTRAINT UQ_sessions_unique_day UNIQUE (lecture_id, planned_date)
  );
  CREATE INDEX IX_sessions_lecture_date ON dbo.lecture_sessions(lecture_id, planned_date);
  CREATE INDEX IX_sessions_status_date  ON dbo.lecture_sessions(status, planned_date);
END
GO

/* 6) ATTENDANCE */
IF OBJECT_ID(N'dbo.attendance_records', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.attendance_records (
    id                     INT IDENTITY(1,1) PRIMARY KEY,
    session_id             INT           NOT NULL,
    user_id                INT           NOT NULL,
    check_in_at            DATETIME2(0)  NULL,
    check_out_at           DATETIME2(0)  NULL,
    status                 NVARCHAR(10)  NOT NULL CONSTRAINT CK_att_status CHECK (status IN ('present','late','left','absent')),
    [source]               NVARCHAR(10)  NOT NULL CONSTRAINT CK_att_source CHECK ([source] IN ('mobile'))
                                        CONSTRAINT DF_att_source DEFAULT('mobile'),
    modulation_string_seen NVARCHAR(128) NULL,
    udid_at_checkin        NVARCHAR(128) NULL,
    CONSTRAINT FK_att_session FOREIGN KEY (session_id) REFERENCES dbo.lecture_sessions(id) ON DELETE CASCADE,
    CONSTRAINT FK_att_user    FOREIGN KEY (user_id)    REFERENCES dbo.users(id) ON DELETE CASCADE,
    CONSTRAINT UQ_att_unique UNIQUE (session_id, user_id)
  );
  CREATE INDEX IX_att_user ON dbo.attendance_records(user_id, session_id);
END
GO

/* 7) POSTS */
IF OBJECT_ID(N'dbo.posts', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.posts (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    session_id  INT            NOT NULL,
    user_id     INT            NOT NULL,
    [type]      NVARCHAR(10)   NOT NULL CONSTRAINT CK_posts_type CHECK ([type] IN ('file','link','text')),
    title       NVARCHAR(200)  NULL,
    body_text   NVARCHAR(MAX)  NULL,
    file_url    NVARCHAR(500)  NULL,
    created_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_posts_created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT FK_posts_session FOREIGN KEY (session_id) REFERENCES dbo.lecture_sessions(id) ON DELETE CASCADE,
    CONSTRAINT FK_posts_user    FOREIGN KEY (user_id)    REFERENCES dbo.users(id)
  );
  CREATE INDEX IX_posts_session ON dbo.posts(session_id);
END
GO

/* 8) PUSH TOKENS */
IF OBJECT_ID(N'dbo.push_tokens', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.push_tokens (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT            NOT NULL,
    platform   NVARCHAR(20)   NOT NULL, -- ios/android/web
    token      NVARCHAR(500)  NOT NULL,
    created_at DATETIME2(0)   NOT NULL CONSTRAINT DF_push_created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT FK_push_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
  );
  CREATE INDEX IX_push_user ON dbo.push_tokens(user_id);
END
GO

/* 9) AUDIT */
IF OBJECT_ID(N'dbo.audit_logs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.audit_logs (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT           NULL,
    action     NVARCHAR(50)  NOT NULL,
    meta       NVARCHAR(MAX) NULL,
    created_at DATETIME2(0)  NOT NULL CONSTRAINT DF_audit_created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT FK_audit_user FOREIGN KEY (user_id) REFERENCES dbo.users(id)
  );
  CREATE INDEX IX_audit_user_time ON dbo.audit_logs(user_id, created_at);
END
GO









///////////// drop unique for udid 

-- Drop old constraint if it exists
IF EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_devices_user')
  DROP INDEX UX_devices_user ON dbo.devices;

IF EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ__devices__udid')
  ALTER TABLE dbo.devices DROP CONSTRAINT UQ__devices__udid; -- adjust name if SQL generated it

-- Recreate table constraint: one device per user (no global UDID uniqueness)
CREATE UNIQUE INDEX UX_devices_user ON dbo.devices(user_id);


-- 1) Drop current unique index on user_id if it exists
IF EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_devices_user' AND object_id = OBJECT_ID('dbo.devices'))
  DROP INDEX UX_devices_user ON dbo.devices;

-- 2) Allow NULL UDIDs
ALTER TABLE dbo.devices ALTER COLUMN udid NVARCHAR(128) NULL;

-- 3) Enforce "one device per user when UDID is set"
CREATE UNIQUE INDEX UX_devices_user_notnull
ON dbo.devices(user_id)
WHERE udid IS NOT NULL;



/// index for lec 
-- Add a persisted end_time column
ALTER TABLE dbo.lectures
ADD end_time AS CAST(DATEADD(MINUTE, duration_minutes, start_time) AS TIME(0)) PERSISTED;

-- Index to speed up overlap lookups
CREATE INDEX IX_lectures_place_day_time
ON dbo.lectures(place, day_of_week, start_time, end_time);

