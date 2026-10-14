-- ==========================================
-- Base de Datos: surco_aprende
-- Cómo usarlo:
--   * phpMyAdmin (XAMPP): pestaña "Importar" -> elegir este archivo -> Continuar
--   * Consola:  mysql -u root -p < database.sql
-- ATENCIÓN: borra y vuelve a crear las tablas (sirve para empezar de cero).
-- ==========================================

CREATE DATABASE IF NOT EXISTS surco_aprende CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE surco_aprende;

-- Se borran en orden inverso a las relaciones para que el script se pueda ejecutar varias veces
DROP TABLE IF EXISTS prestamos;
DROP TABLE IF EXISTS practica;
DROP TABLE IF EXISTS artistas;
DROP TABLE IF EXISTS libros;
DROP TABLE IF EXISTS socios;

-- 1. Tabla de Socios / Usuarios
CREATE TABLE socios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    tipo VARCHAR(50) DEFAULT 'Estudiante',
    fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Tabla de Libros / Recursos
CREATE TABLE libros (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(150) NOT NULL,
    autor VARCHAR(100) NOT NULL,
    categoria VARCHAR(50),
    stock INT DEFAULT 5
) ENGINE=InnoDB;

-- 3. Tabla de Préstamos (con relaciones en cascada)
CREATE TABLE prestamos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_socio INT NOT NULL,
    id_libro INT NOT NULL,
    fecha_prestamo DATE NOT NULL,
    fecha_devolucion DATE,
    estado ENUM('Pendiente', 'Devuelto', 'Atrasado') DEFAULT 'Pendiente',
    CONSTRAINT fk_socio FOREIGN KEY (id_socio)
        REFERENCES socios(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_libro FOREIGN KEY (id_libro)
        REFERENCES libros(id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Tabla de Artistas / Contenido
CREATE TABLE artistas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    biografia TEXT,
    imagen VARCHAR(255)
) ENGINE=InnoDB;

-- 5. Tabla de Práctica / Ejercicios
CREATE TABLE practica (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pregunta TEXT NOT NULL,
    opcion_a VARCHAR(255),
    opcion_b VARCHAR(255),
    opcion_c VARCHAR(255),
    respuesta_correcta VARCHAR(10)
) ENGINE=InnoDB;

-- ==========================================
-- Datos de prueba iniciales
-- ==========================================

INSERT INTO socios (nombre, email, tipo) VALUES
('Juan Pérez', 'juan.perez@tecnica35.edu.ar', 'Estudiante'),
('María Gómez', 'maria.gomez@tecnica35.edu.ar', 'Profesor');

INSERT INTO libros (titulo, autor, categoria, stock) VALUES
('Historia Argentina (1930-1945)', 'Felipe Pigna', 'Historia', 4),
('Matemática: Matrices y Operaciones', 'Carlos Smith', 'Ciencias Exactas', 3),
('Introducción a SQL y Bases de Datos', 'Ana Torres', 'Informática', 6);

INSERT INTO prestamos (id_socio, id_libro, fecha_prestamo, estado) VALUES
(1, 3, '2026-10-01', 'Pendiente'),
(2, 1, '2026-09-20', 'Devuelto');

INSERT INTO artistas (nombre, biografia, imagen) VALUES
('Artistas del Surco', 'Comunidad artística y cultural de la Escuela Técnica N.º 35.', 'logo-header.png');

INSERT INTO practica (pregunta, opcion_a, opcion_b, opcion_c, respuesta_correcta) VALUES
('¿Cuántas notas naturales tiene la escala de Do mayor?', '5', '7', '12', 'B'),
('¿Qué notas forman el acorde de Do mayor?', 'Do + Mi + Sol', 'Do + Re + Mi', 'La + Do + Mi', 'A'),
('¿Qué operación matricial utiliza F1 * (k) + Fn?', 'Combinación lineal / Operación elemental por filas', 'Determinante', 'Inversa', 'A');
