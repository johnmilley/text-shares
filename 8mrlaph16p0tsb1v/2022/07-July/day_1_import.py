# This script adds a formatted date to start of .md files 
# and appends 2 carriage returns. The formatted date is
# converted from the YYYY-MM-DD format in the file name.

# File names must be in the specified format

import datetime
import glob
import os
from pickle import TRUE
import subprocess
import sys

files = os.listdir()

for f in files:
    if f.endswith('.md'): # also check if in correct format
    
        # get the date from the filename
        date = datetime.date(int(f[0:4]), int(f[5:7]), int(f[8:10]))

        #date_str to prepend
        date_str = date.strftime("Date: %B %-d, %Y at 00:00:00 AM NST\n\n")

        with open(f, 'r') as original:
            file_contents = original.read()
            with open(f'{f[:-3]}.txt', 'a') as new_file:
                new_file.write(f"{date_str}\n\n{file_contents}\n\n")


# combine all newly created txt files into one txt file
subprocess.Popen('cat *.txt > month.txt', shell=True)

## FOR FUTURE JOHN WHO COMES BACK TO THIS.
#  Script works, but is not yet robust
    #   -> Run script in dir on YYYY-DD-MM.md files 
    #   -> cat textfiles to month.txt
    #   -> import month.txt into Day One

    # could look into day one CLI tools.
    # need to manually rename files anyhow...

# TARGET FOLDERS
    # Dropbox/Writing/Journal
    # wrote_down_life/Daily



# SCRATCH 
    # print(f[:-3]) # datetime 
    # print(datetime.date(int(f[0:4]), int(f[5:7]), int(f[8:10])))