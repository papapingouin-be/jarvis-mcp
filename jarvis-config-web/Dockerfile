FROM php:8.2-apache

# installation outils système
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client \
    sshpass \
    git \
    curl \
    nano \
    postgresql-client \
    libpq-dev \
    mariadb-client \
    sqlite3 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# extensions PHP
RUN docker-php-ext-install \
    mysqli \
    pdo \
    pdo_mysql \
    pdo_pgsql

# activation modules apache utiles
RUN a2enmod rewrite

WORKDIR /var/www/html
