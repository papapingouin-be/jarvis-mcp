FROM serversideup/php:8.2-fpm-apache

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client sshpass \
  && rm -rf /var/lib/apt/lists/*

USER www-data
