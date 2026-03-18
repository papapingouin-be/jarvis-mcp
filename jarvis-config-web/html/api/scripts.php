<?php
$db=getenv("DATABASE_URL");
$conn=pg_connect($db);

if(isset($_GET["run"])){
$name=$_GET["run"];
$out=shell_exec("/var/www/data/scripts/sh/".$name);

file_put_contents(
"/var/www/data/logs/actions.log",
date("c")." run ".$name."\n",
FILE_APPEND
);

echo $out;
exit;
}

$res=pg_query($conn,"SELECT * FROM jarvis_script_registry");

echo "<h2>Scripts</h2>";
echo "<table>";

while($r=pg_fetch_assoc($res)){
echo "<tr>";
echo "<td>".$r['script_name']."</td>";
echo "<td>".$r['file_name']."</td>";
echo "<td>".$r['is_active']."</td>";
echo "<td><button onclick=\"runScript('".$r['file_name']."')\">RUN</button></td>";
echo "</tr>";
}

echo "</table>";
?>