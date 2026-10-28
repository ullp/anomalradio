WEBSITE INFO DOMAIN
Create website for music radio which will play only it's own music.
The name of the radio is Anomalradio.com. We have the domain as well.

DNS
Hostname TTL Typ Hodnota
anomalradio.com 1800 A 81.2.196.19 [Upravit | Smazat]
*.anomalradio.com 1800 CNAME anomalradio.com [Upravit | Smazat]

GIT
https://github.com/ullp/anomalradio
https://github.com/ullp/anomalradio.git

echo "# anomalradio" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/ullp/anomalradio.git
git push -u origin main

git remote add origin https://github.com/ullp/anomalradio.git
git branch -M main
git push -u origin main

DESIGN
Logo is in _data/logo/anomalradiocom-logo.jpeg
There should be nice modern fturistic radio design.

PLAYER
The files should play automaticaly like in https://somafm.com/ or https://somafm.com/groovesalad/
I will palce the tracks in mp3 format in directory you decide to have the files.
There must me protection for the files to not be able to download.
There must be a player in which the files can be played.
The files in the player can be stored elsewhere to protect them and serve under ids. I think there is some option to
upload the files and provide their protected path or url.

SECURITY
We would like to have ability to play our music for people. But we would also like avoid the music to be downloaded
or dropped from hackers.

BUSINESS CASE
The player should work as automated radio player like in https://somafm.com/player24/station/groovesalad
There are options for each track to:
star - to add to favourites
basket - to add the track to cart and buy
share - cocial urls to share the track from this radio
